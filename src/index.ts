import { emptyResponse, jsonResponse, notFound } from "./http";
import { handleAuth } from "./routes/auth";
import { handleAccessEvents } from "./routes/access-events";
import { handleAi } from "./routes/ai";
import { handleFamilies } from "./routes/families";
import { handleReminderRecords } from "./routes/reminder-records";
import { handleSubmissions } from "./routes/submissions";
import { handleTasks } from "./routes/tasks";
import { handleUsers } from "./routes/users";
import { handleRewards } from "./routes/rewards";
import { getAuthUser, isAuthConfigured } from "./services/auth";
import { getAiConfig, isAiConfigured } from "./services/ai";
import { generateDailyAiAnalyses, shouldRunDailyAiAnalysis } from "./services/ai-analysis";
import { processPendingLearningIssueAnalyses } from "./services/ai-learning-issues";
import { recordApiAccessEvent } from "./services/access-events";
import { sendDueClaimReminders, sendDueRevisionReminders } from "./services/tasks";
import { UserRealtime } from "./services/realtime";
import { verifyToken } from "./services/auth";
import type { Env } from "./types";

export { UserRealtime };

function realtimeToken(request: Request) {
  const protocols = (request.headers.get("sec-websocket-protocol") || "")
    .split(",")
    .map((value) => value.trim());
  const encoded = protocols.find((value) => value.startsWith("token."));
  return encoded?.slice("token.".length) || "";
}

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

    if (request.method === "GET" && url.pathname === "/api/realtime") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse({ error: "Expected WebSocket upgrade." }, { status: 426 });
      }
      const user = await verifyToken(env, realtimeToken(request));
      if (!user || user.role !== "child") {
        return jsonResponse({ error: "Unauthorized." }, { status: 401 });
      }
      return env.USER_REALTIME.getByName(user.id).fetch(request);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const authConfigured = isAuthConfigured(env);
      const aiConfigured = isAiConfigured(env);
      const aiConfig = getAiConfig(env);
      return jsonResponse({
        ok: authConfigured,
        service: "starbud-backend",
        checks: {
          authentication: authConfigured ? "ready" : "not_configured",
          ai: aiConfigured ? "ready" : "not_configured"
        },
        ai: {
          provider: aiConfig.provider,
          model: aiConfig.model,
          reasoningEffort: aiConfig.reasoningEffort,
          responseStorageEnabled: aiConfig.responseStorageEnabled
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

    const aiResponse = await handleAi(request, env, url);

    if (aiResponse) {
      return trackedResponse(request, env, url, aiResponse);
    }

    const familyResponse = await handleFamilies(request, env, url);

    if (familyResponse) {
      return trackedResponse(request, env, url, familyResponse);
    }

    const userResponse = await handleUsers(request, env, url);

    if (userResponse) {
      return trackedResponse(request, env, url, userResponse);
    }

    const rewardResponse = await handleRewards(request, env, url);

    if (rewardResponse) {
      return trackedResponse(request, env, url, rewardResponse);
    }

    const submissionResponse = await handleSubmissions(request, env, url);

    if (submissionResponse) {
      return trackedResponse(request, env, url, submissionResponse);
    }

    const reminderRecordResponse = await handleReminderRecords(request, env, url);

    if (reminderRecordResponse) {
      return trackedResponse(request, env, url, reminderRecordResponse);
    }

    const taskResponse = await handleTasks(request, env, url);

    if (taskResponse) {
      return trackedResponse(request, env, url, taskResponse);
    }

    return notFound();
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendDueClaimReminders(env));
    ctx.waitUntil(sendDueRevisionReminders(env));
    ctx.waitUntil(processPendingLearningIssueAnalyses(env));
    if (shouldRunDailyAiAnalysis(env)) {
      ctx.waitUntil(generateDailyAiAnalyses(env));
    }
  }
};
