import type { AuthUser, Env, UserRow } from "../types";

const encoder = new TextEncoder();
const tokenTtlSeconds = 60 * 60 * 24 * 7;

function base64UrlEncode(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function jwtSecret(env: Env) {
  return env.JWT_SECRET || "starbud-local-development-secret";
}

export async function hashPassword(password: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  return base64UrlEncode(digest);
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role
  };
}

export async function findUserByUsername(env: Env, username: string) {
  return env.DB.prepare("SELECT * FROM users WHERE username = ? AND active = 1 LIMIT 1")
    .bind(username)
    .first<UserRow>();
}

export async function findUserById(env: Env, userId: string) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1 LIMIT 1")
    .bind(userId)
    .first<UserRow>();
}

export async function loginUser(env: Env, username: string, password: string) {
  const user = await findUserByUsername(env, username);

  if (!user) {
    return null;
  }

  const passwordHash = await hashPassword(password);

  if (passwordHash !== user.password_hash) {
    return null;
  }

  const authUser = toAuthUser(user);
  return {
    user: authUser,
    token: await signToken(env, authUser)
  };
}

export async function signToken(env: Env, user: AuthUser) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: user.id,
      username: user.username,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + tokenTtlSeconds
    })
  );
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(jwtSecret(env)), encoder.encode(data));

  return `${data}.${base64UrlEncode(signature)}`;
}

export async function verifyToken(env: Env, token: string) {
  const [header, payload, signature] = token.split(".");

  if (!header || !payload || !signature) {
    return null;
  }

  const data = `${header}.${payload}`;
  const signatureBytes = Uint8Array.from(
    atob(signature.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(signature.length / 4) * 4, "=")),
    (char) => char.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(jwtSecret(env)),
    signatureBytes,
    encoder.encode(data)
  );

  if (!valid) {
    return null;
  }

  const claims = JSON.parse(base64UrlDecode(payload)) as { sub?: string; exp?: number };

  if (!claims.sub || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  const user = await findUserById(env, claims.sub);
  return user ? toAuthUser(user) : null;
}

export async function getAuthUser(request: Request, env: Env) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  return token ? verifyToken(env, token) : null;
}
