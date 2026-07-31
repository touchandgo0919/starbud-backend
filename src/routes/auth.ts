import { badRequest, jsonResponse, serviceUnavailable, unauthorized } from "../http";
import { ensureDefaultUsers } from "../db/seed";
import { getAuthUser, isAuthConfigured, loginUser, signToken } from "../services/auth";
import { listChildren } from "../services/children";
import { registerParent } from "../services/users";
import { recordAccessEvent } from "../services/access-events";
import type { AuthUser, Env } from "../types";

async function recordAuthEvent(env: Env, request: Request, input: Parameters<typeof recordAccessEvent>[1]) {
  try {
    await recordAccessEvent(env, {
      ...input,
      clientType: request.headers.get("x-starbud-client") || "web",
      userAgent: request.headers.get("user-agent") || undefined,
      sessionId: request.headers.get("x-starbud-session-id") || undefined
    });
  } catch (error) {
    console.error("Failed to record auth access event:", error);
  }
}

export async function handleAuth(request: Request, env: Env, url: URL) {
  if (
    (request.method === "POST" && url.pathname === "/api/auth/register") ||
    (request.method === "POST" && url.pathname === "/api/auth/login")
  ) {
    if (!isAuthConfigured(env)) {
      return serviceUnavailable("登录服务尚未配置，请联系管理员。");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    await ensureDefaultUsers(env);

    const input = (await request.json().catch(() => null)) as {
      username?: string;
      displayName?: string;
      password?: string;
    } | null;

    if (!input) {
      return badRequest("Invalid JSON body.");
    }

    try {
      const created = await registerParent(env, input);

      if (!created) {
        return badRequest("注册失败。");
      }

      const user: AuthUser = {
        id: created.id,
        username: created.username,
        displayName: created.displayName,
        role: created.role
      };

      await recordAuthEvent(env, request, {
        user,
        eventName: "parent_registered",
        route: url.pathname
      });

      return jsonResponse({ user, token: await signToken(env, user) }, { status: 201 });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "注册失败。");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    await ensureDefaultUsers(env);

    const input = (await request.json().catch(() => null)) as {
      username?: string;
      password?: string;
    } | null;

    if (!input?.username || !input.password) {
      await recordAuthEvent(env, request, {
        eventName: "login_attempt",
        route: url.pathname,
        outcome: "failure",
        metadata: { reason: "missing_credentials" }
      });
      return badRequest("Username and password are required.");
    }

    const session = await loginUser(env, input.username.trim(), input.password);

    if (!session) {
      await recordAuthEvent(env, request, {
        eventName: "login_attempt",
        route: url.pathname,
        outcome: "failure",
        metadata: { reason: "invalid_credentials" }
      });
      return unauthorized("Invalid username or password.");
    }

    await recordAuthEvent(env, request, {
      user: session.user,
      eventName: "login_succeeded",
      route: url.pathname
    });

    return jsonResponse(session);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const user = await getAuthUser(request, env);
    if (user) {
      await recordAuthEvent(env, request, {
        user,
        eventName: "logout",
        route: url.pathname
      });
    }
    return jsonResponse({ loggedOut: true });
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
