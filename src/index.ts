import { emptyResponse, jsonResponse, notFound } from "./http";
import { handleAuth } from "./routes/auth";
import { handleAccessEvents } from "./routes/access-events";
import { handleFamilies } from "./routes/families";
import { handleSubmissions } from "./routes/submissions";
import { handleTasks } from "./routes/tasks";
import { handleUsers } from "./routes/users";
import { getAuthUser, isAuthConfigured } from "./services/auth";
import { recordApiAccessEvent } from "./services/access-events";
import { sendDueClaimReminders } from "./services/tasks";
import type { Env } from "./types";

async function trackedResponse(request: Request, env: Env, url: URL, response: Response) {
  try {
    await recordApiAccessEvent(env, request, url, response.status, await getAuthUser(request, env));
  } catch (error) {
    console.error("Failed to record access event:", error);
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      // 允许浏览器为客户端追踪附加 x-starbud-* 请求头，避免每次新增标识头都触发 CORS 失败。
      const requestedClientHeaders = (request.headers.get("access-control-request-headers") || "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter((header) => /^x-starbud-[a-z0-9-]+$/.test(header));
      const allowedHeaders = ["content-type", "authorization", ...requestedClientHeaders]
        .filter((header, index, headers) => headers.indexOf(header) === index)
        .join(",");

      return emptyResponse({
        status: 204,
        headers: { "access-control-allow-headers": allowedHeaders }
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const authConfigured = isAuthConfigured(env);
      return jsonResponse({
        ok: authConfigured,
        service: "starbud-backend",
        checks: {
          authentication: authConfigured ? "ready" : "not_configured"
        }
      }, { status: authConfigured ? 200 : 503 });
    }

    const authResponse = await handleAuth(request, env, url);

    if (authResponse) {
      return trackedResponse(request, env, url, authResponse);
    }

    const accessEventsResponse = await handleAccessEvents(request, env, url);

    if (accessEventsResponse) {
      return accessEventsResponse;
    }

    const familyResponse = await handleFamilies(request, env, url);

    if (familyResponse) {
      return trackedResponse(request, env, url, familyResponse);
    }

    const userResponse = await handleUsers(request, env, url);

    if (userResponse) {
      return trackedResponse(request, env, url, userResponse);
    }

    const submissionResponse = await handleSubmissions(request, env, url);

    if (submissionResponse) {
      return trackedResponse(request, env, url, submissionResponse);
    }

    const taskResponse = await handleTasks(request, env, url);

    if (taskResponse) {
      return trackedResponse(request, env, url, taskResponse);
    }

    return notFound();
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendDueClaimReminders(env));
  }
};
