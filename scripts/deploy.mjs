import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const requiredSecret = "JWT_SECRET";

function runWrangler(args, options = {}) {
  return spawnSync("npx", ["wrangler", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    ...options
  });
}

function printFailure(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function listRemoteSecrets() {
  const result = runWrangler(["secret", "list", "--format", "json"]);

  if (result.status !== 0) {
    printFailure(result);
    throw new Error(
      "无法读取 Worker Secret。请确认 Cloudflare 部署凭据包含 Workers Scripts:Edit 权限。"
    );
  }

  try {
    const secrets = JSON.parse(result.stdout);
    return new Set(secrets.map((secret) => secret.name));
  } catch {
    printFailure(result);
    throw new Error("Wrangler 返回了无法识别的 Secret 列表。");
  }
}

function deploy(args = []) {
  const result = runWrangler(["deploy", ...args], { stdio: "inherit", encoding: undefined });

  if (result.status !== 0) {
    const error = new Error("Worker 部署失败。");
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

let temporaryDirectory;

try {
  const remoteSecrets = listRemoteSecrets();

  if (remoteSecrets.has(requiredSecret)) {
    console.log(`${requiredSecret} 已存在，将复用现有密钥。`);
    deploy();
  } else {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "starbud-deploy-"));
    const secretsFile = join(temporaryDirectory, "secrets.env");
    const generatedSecret = randomBytes(48).toString("base64url");

    writeFileSync(secretsFile, `${requiredSecret}=${generatedSecret}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    chmodSync(secretsFile, 0o600);

    console.log(`${requiredSecret} 不存在，正在生成并随本次部署安全上传。`);
    deploy(["--secrets-file", secretsFile]);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker 部署失败。");
  process.exitCode =
    error && typeof error === "object" && "exitCode" in error
      ? Number(error.exitCode) || 1
      : 1;
} finally {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
