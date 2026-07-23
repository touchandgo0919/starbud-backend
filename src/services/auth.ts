import type { AuthUser, Env, UserRow } from "../types";

const encoder = new TextEncoder();
const tokenTtlSeconds = 60 * 60 * 24 * 7;
const passwordHashAlgorithm = "pbkdf2-sha256";
const passwordHashIterations = 100_000;

function base64UrlEncode(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}

function base64UrlDecodeBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
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
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters.");
  }
  return env.JWT_SECRET;
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const digest = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: passwordHashIterations
    },
    passwordKey,
    256
  );

  return [
    passwordHashAlgorithm,
    passwordHashIterations,
    base64UrlEncode(salt.buffer),
    base64UrlEncode(digest)
  ].join("$");
}

async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, iterationsText, saltText, digestText] = storedHash.split("$");

  if (
    algorithm === passwordHashAlgorithm &&
    iterationsText &&
    saltText &&
    digestText
  ) {
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) {
      return false;
    }

    const passwordKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const actualDigest = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: base64UrlDecodeBytes(saltText),
          iterations
        },
        passwordKey,
        256
      )
    );
    const expectedDigest = base64UrlDecodeBytes(digestText);

    if (actualDigest.length !== expectedDigest.length) {
      return false;
    }

    let difference = 0;
    for (let index = 0; index < actualDigest.length; index += 1) {
      difference |= actualDigest[index] ^ expectedDigest[index];
    }
    return difference === 0;
  }

  const legacyDigest = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  return base64UrlEncode(legacyDigest) === storedHash;
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

  if (!(await verifyPassword(password, user.password_hash))) {
    return null;
  }

  if (!user.password_hash.startsWith(`${passwordHashAlgorithm}$`)) {
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(await hashPassword(password), user.id)
      .run();
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
  try {
    const [header, payload, signature, extra] = token.split(".");

    if (!header || !payload || !signature || extra) {
      return null;
    }

    const parsedHeader = JSON.parse(base64UrlDecode(header)) as { alg?: string; typ?: string };
    if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "JWT") {
      return null;
    }

    const data = `${header}.${payload}`;
    const signatureBytes = base64UrlDecodeBytes(signature);
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
  } catch {
    return null;
  }
}

export async function getAuthUser(request: Request, env: Env) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  return token ? verifyToken(env, token) : null;
}
