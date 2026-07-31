import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const validModes = new Set(["local", "remote"]);

if (!validModes.has(mode)) {
  throw new Error("用法：node scripts/apply-idempotent-migrations.mjs <local|remote>");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const migrationsDir = resolve(backendDir, "..", "migrations");
const databaseName = "starbud";
const wranglerTarget = mode === "remote" ? "--remote" : "--local";

function runWrangler(args, options = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: backendDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const error = new Error(`${options.label || "Wrangler 命令执行失败"}\n${detail}`);
    error.output = detail;
    throw error;
  }

  return result.stdout;
}

function parseJsonOutput(output) {
  const start = output.indexOf("[");
  if (start < 0) return [];
  return JSON.parse(output.slice(start));
}

function executeSql(command, label) {
  const output = runWrangler([
    "d1",
    "execute",
    databaseName,
    wranglerTarget,
    "--json",
    "--command",
    command
  ], { label });

  return parseJsonOutput(output);
}

async function executeSqlFile(command, label) {
  const tempDir = await mkdtemp(join(tmpdir(), "starbud-d1-migration-"));
  const tempFile = join(tempDir, "statement.sql");
  try {
    await writeFile(tempFile, command);
    const output = runWrangler([
      "d1",
      "execute",
      databaseName,
      wranglerTarget,
      "--json",
      "--file",
      tempFile
    ], { label });

    return parseJsonOutput(output);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function stripSqlComments(statement) {
  return statement
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }

    if (!quote && char === "-" && next === "-") {
      lineComment = true;
      current += char;
      continue;
    }

    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      if (quote === char && sql[index + 1] === char) {
        current += char + sql[index + 1];
        index += 1;
        continue;
      }
      quote = quote ? null : char;
    }

    if (!quote && char === ";") {
      if (stripSqlComments(current)) statements.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (stripSqlComments(current)) statements.push(current.trim());
  return statements;
}

function normalizeIdentifier(identifier) {
  return identifier.replace(/^["'`\[]|["'`\]]$/g, "");
}

function parseAddColumn(statement) {
  const normalized = stripSqlComments(statement).replace(/\s+/g, " ");
  const match = /^ALTER\s+TABLE\s+([`"[\]\w]+)\s+ADD\s+COLUMN\s+([`"[\]\w]+)\s+(.+)$/i.exec(normalized);
  if (!match) return null;
  return {
    table: normalizeIdentifier(match[1]),
    column: normalizeIdentifier(match[2])
  };
}

function rowsFromResult(result) {
  return result.flatMap((item) => Array.isArray(item.results) ? item.results : []);
}

function tableExists(tableName) {
  const escapedTable = tableName.replaceAll("'", "''");
  const result = executeSql(
    `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = '${escapedTable}' LIMIT 1;`,
    `检查表 ${tableName}`
  );
  return rowsFromResult(result).length > 0;
}

function columnExists(tableName, columnName) {
  if (!tableExists(tableName)) return false;
  const escapedTable = tableName.replaceAll("'", "''");
  const result = executeSql(`PRAGMA table_info('${escapedTable}');`, `检查列 ${tableName}.${columnName}`);
  return rowsFromResult(result).some((row) => row.name === columnName);
}

function ensureMigrationTables() {
  executeSql(
    `CREATE TABLE IF NOT EXISTS starbud_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    "创建 starbud_migrations"
  );
}

function appliedMigrationNames() {
  const result = executeSql("SELECT name FROM starbud_migrations;", "读取 starbud_migrations");
  return new Set(rowsFromResult(result).map((row) => row.name));
}

function importWranglerMigrationHistory() {
  if (!tableExists("d1_migrations")) return;
  const result = executeSql("SELECT name FROM d1_migrations;", "读取 d1_migrations");
  const names = rowsFromResult(result).map((row) => row.name).filter(Boolean);
  for (const name of names) {
    const escapedName = String(name).replaceAll("'", "''");
    executeSql(
      `INSERT OR IGNORE INTO starbud_migrations (name) VALUES ('${escapedName}');`,
      `导入已执行迁移 ${name}`
    );
  }
}

function markMigrationApplied(name) {
  const escapedName = name.replaceAll("'", "''");
  executeSql(
    `INSERT OR REPLACE INTO starbud_migrations (name, applied_at) VALUES ('${escapedName}', CURRENT_TIMESTAMP);`,
    `记录迁移 ${name}`
  );
}

async function applyStatement(fileName, statement, index) {
  const addColumn = parseAddColumn(statement);
  if (addColumn && columnExists(addColumn.table, addColumn.column)) {
    console.log(`- ${fileName} #${index}: 跳过已存在列 ${addColumn.table}.${addColumn.column}`);
    return;
  }

  try {
    await executeSqlFile(statement, `${fileName} #${index}`);
  } catch (error) {
    if (
      addColumn &&
      /duplicate column name/i.test(String(error.output || error.message)) &&
      columnExists(addColumn.table, addColumn.column)
    ) {
      console.log(`- ${fileName} #${index}: 已存在列 ${addColumn.table}.${addColumn.column}，按幂等跳过`);
      return;
    }
    throw error;
  }
  console.log(`- ${fileName} #${index}: 已执行`);
}

ensureMigrationTables();
importWranglerMigrationHistory();

const applied = appliedMigrationNames();
const migrationFiles = (await readdir(migrationsDir))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();

for (const fileName of migrationFiles) {
  if (applied.has(fileName)) {
    console.log(`跳过 ${fileName}：已记录执行`);
    continue;
  }

  const sql = await readFile(join(migrationsDir, fileName), "utf8");
  const statements = splitSqlStatements(sql);
  console.log(`执行 ${fileName}，${statements.length} 条语句`);

  for (const [index, statement] of statements.entries()) {
    await applyStatement(fileName, statement, index + 1);
  }

  markMigrationApplied(fileName);
}

console.log(`D1 ${mode === "remote" ? "远程" : "本地"}迁移完成。`);
