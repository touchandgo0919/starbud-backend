import { badRequest, forbidden, jsonResponse } from "../http";
import { getAuthUser } from "../services/auth";
import { listAccessEvents, recordAccessEvent } from "../services/access-events";
import type { Env } from "../types";

const clientEvents = new Set(["task_detail_viewed"]);
const sessionIdPattern = /^[a-zA-Z0-9_-]{8,80}$/;

export async function handleAccessEvents(request: Request, env: Env, url: URL) {
  if (!url.pathname.startsWith("/api/access-events")) return null;

  const user = await getAuthUser(request, env);

  if (request.method === "POST" && url.pathname === "/api/access-events") {
    const input = (await request.json().catch(() => null)) as {
      eventName?: string; route?: string; resourceType?: string; resourceId?: string;
      outcome?: "success" | "failure"; metadata?: Record<string, unknown>;
    } | null;
    if (!input?.eventName) return badRequest("eventName is required.");
    if (!clientEvents.has(input.eventName)) return badRequest("Unsupported client event.");
    if (!user) return forbidden("登录后才能记录该事件。");
    const sessionId = request.headers.get("x-starbud-session-id") || "";
    if (!sessionIdPattern.test(sessionId)) return badRequest("Invalid access session.");
    const route = input.route?.trim() || "";
    if (!route) return badRequest("route is required.");

    await recordAccessEvent(env, {
      user,
      eventName: input.eventName,
      clientType: request.headers.get("x-starbud-client") || "web",
      route,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: "success",
      metadata: { ...input.metadata, origin: "client" },
      userAgent: request.headers.get("user-agent") || undefined,
      sessionId
    });
    return jsonResponse({ recorded: true }, { status: 202 });
  }

  if (request.method === "GET" && url.pathname === "/api/access-events") {
    if (user?.role !== "admin") return forbidden("仅系统管理员可以查看访问记录。");
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "30", 10) || 30));
    return jsonResponse(await listAccessEvents(env, {
      eventName: url.searchParams.get("eventName") || undefined,
      clientType: url.searchParams.get("clientType") || undefined,
      userId: url.searchParams.get("userId") || undefined,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
      page,
      pageSize
    }));
  }

  return null;
}
