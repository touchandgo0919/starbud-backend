import { randomId } from "../utils";
import { hashPassword } from "./auth";
import type { AdminUserDto, AuthUser, Env, SaveUserInput, UserRole, UserRow } from "../types";

const roles: UserRole[] = ["admin", "parent", "child"];

export async function listUsers(env: Env) {
  const result = await env.DB.prepare(
    `SELECT * FROM users
     ORDER BY active DESC,
      CASE role WHEN 'admin' THEN 0 WHEN 'parent' THEN 1 ELSE 2 END,
      display_name ASC,
      username ASC`
  ).all<UserRow>();

  return result.results.map(toAdminUserDto);
}

export async function createUser(env: Env, actor: AuthUser, input: SaveUserInput) {
  requireAdmin(actor);
  const username = normalizeUsername(input.username);
  const displayName = normalizeDisplayName(input.displayName, username);
  const role = normalizeRole(input.role);
  const password = normalizePassword(input.password, true);
  const id = randomId("user");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ? LIMIT 1")
    .bind(username)
    .first<{ id: string }>();

  if (existing) {
    throw new Error("用户名已存在。");
  }

  await env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  )
    .bind(id, username, await hashPassword(password), displayName, role)
    .run();

  if (role === "child") {
    await ensureChildProfile(env, id, displayName);
  }

  return getUser(env, id);
}

export async function updateUser(
  env: Env,
  actor: AuthUser,
  userId: string,
  input: SaveUserInput
) {
  requireAdmin(actor);
  const current = await env.DB.prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<UserRow>();

  if (!current) {
    return null;
  }

  const username = input.username === undefined ? current.username : normalizeUsername(input.username);
  const displayName =
    input.displayName === undefined
      ? current.display_name || current.username
      : normalizeDisplayName(input.displayName, username);
  const role = input.role === undefined ? current.role : normalizeRole(input.role);
  const active = input.active === undefined ? Boolean(current.active) : input.active;

  if (actor.id === userId && (role !== "admin" || !active)) {
    throw new Error("不能移除当前管理员自己的权限或停用当前账号。");
  }

  const duplicate = await env.DB.prepare(
    "SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1"
  )
    .bind(username, userId)
    .first<{ id: string }>();

  if (duplicate) {
    throw new Error("用户名已存在。");
  }

  const password = normalizePassword(input.password, false);
  const passwordHash = password ? await hashPassword(password) : current.password_hash;

  await env.DB.prepare(
    `UPDATE users
     SET username = ?, display_name = ?, role = ?, active = ?, password_hash = ?
     WHERE id = ?`
  )
    .bind(username, displayName, role, active ? 1 : 0, passwordHash, userId)
    .run();

  if (role === "child") {
    await ensureChildProfile(env, userId, displayName);
  } else {
    await env.DB.prepare("UPDATE children SET name = ? WHERE child_user_id = ?")
      .bind(displayName, userId)
      .run();
  }

  return getUser(env, userId);
}

async function getUser(env: Env, userId: string) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<UserRow>();
  return user ? toAdminUserDto(user) : null;
}

async function ensureChildProfile(env: Env, userId: string, displayName: string) {
  const child = await env.DB.prepare("SELECT id FROM children WHERE child_user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();

  if (child) {
    await env.DB.prepare("UPDATE children SET name = ? WHERE id = ?")
      .bind(displayName, child.id)
      .run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO children (id, user_id, child_user_id, name, device_id)
     VALUES (?, ?, ?, ?, NULL)`
  )
    .bind(randomId("child"), userId, userId, displayName)
    .run();
}

function toAdminUserDto(user: UserRow): AdminUserDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    active: Boolean(user.active),
    createdAt: user.created_at
  };
}

function requireAdmin(user: AuthUser) {
  if (user.role !== "admin") {
    throw new Error("仅系统管理员可以配置用户。");
  }
}

function normalizeUsername(username?: string) {
  const normalized = username?.trim();
  if (!normalized || !/^[A-Za-z0-9._-]{3,40}$/.test(normalized)) {
    throw new Error("用户名需为 3–40 位字母、数字、点、横线或下划线。");
  }
  return normalized;
}

function normalizeDisplayName(displayName: string | undefined, fallback: string) {
  const normalized = displayName?.trim() || fallback;
  if (normalized.length > 40) {
    throw new Error("显示名称不能超过 40 个字符。");
  }
  return normalized;
}

function normalizeRole(role?: UserRole) {
  if (!role || !roles.includes(role)) {
    throw new Error("请选择有效角色。");
  }
  return role;
}

function normalizePassword(password: string | undefined, required: boolean) {
  const normalized = password?.trim() || "";
  if (required && !normalized) {
    throw new Error("请输入初始密码。");
  }
  if (normalized && normalized.length < 6) {
    throw new Error("密码至少需要 6 个字符。");
  }
  return normalized;
}
