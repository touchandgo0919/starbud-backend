import { badRequest, jsonResponse, unauthorized } from "../http";
import { ensureDefaultUsers } from "../db/seed";
import { getAuthUser, loginUser } from "../services/auth";
import { listChildren } from "../services/children";
import type { Env } from "../types";

export async function handleAuth(request: Request, env: Env, url: URL) {
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    await ensureDefaultUsers(env);

    const input = (await request.json().catch(() => null)) as {
      username?: string;
      password?: string;
    } | null;

    if (!input?.username || !input.password) {
      return badRequest("Username and password are required.");
    }

    const session = await loginUser(env, input.username.trim(), input.password);

    if (!session) {
      return unauthorized("Invalid username or password.");
    }

    return jsonResponse(session);
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    await ensureDefaultUsers(env);

    const user = await getAuthUser(request, env);

    if (!user) {
      return unauthorized();
    }

    return jsonResponse({ user });
  }

  if (request.method === "GET" && url.pathname === "/api/children") {
    await ensureDefaultUsers(env);

    const user = await getAuthUser(request, env);

    if (!user) {
      return unauthorized();
    }

    return jsonResponse({ children: await listChildren(env, user) });
  }

  return null;
}
