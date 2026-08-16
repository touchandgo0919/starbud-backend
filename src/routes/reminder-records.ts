import { badRequest, forbidden, jsonResponse, unauthorized } from "../http";
import { getAuthUser } from "../services/auth";
import {
  listReminderRecords,
  recordScheduledTaskReminder,
  reportNotificationReminderResult,
  type ReminderResultStatus
} from "../services/reminder-records";
import type { Env } from "../types";

const resultStatuses = new Set<ReminderResultStatus>(["success", "failed", "skipped"]);

export async function handleReminderRecords(request: Request, env: Env, url: URL) {
  const notificationResultMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/reminder-result$/);
  const taskResultMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reminder-result$/);
  if (url.pathname !== "/api/reminder-records" && !notificationResultMatch && !taskResultMatch) return null;

  const user = await getAuthUser(request, env);
  if (!user) return unauthorized();

  if (request.method === "GET" && url.pathname === "/api/reminder-records") {
    if (user.role === "child") return forbidden("仅家长或管理员可以查看提醒记录。");
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
    const result = await listReminderRecords(env, user, {
      childId: url.searchParams.get("childId") || undefined,
      reminderType: url.searchParams.get("reminderType") || undefined,
      status: url.searchParams.get("status") || undefined,
      keyword: url.searchParams.get("keyword") || undefined,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
      page,
      pageSize
    });
    return jsonResponse({
      records: result.records,
      pagination: { page, pageSize, total: result.total, hasMore: page * pageSize < result.total }
    });
  }

  if (request.method === "POST" && notificationResultMatch) {
    const input = (await request.json().catch(() => null)) as { status?: ReminderResultStatus; error?: string } | null;
    if (!input?.status || !resultStatuses.has(input.status)) return badRequest("无效的提醒结果。");
    const ok = await reportNotificationReminderResult(env, user, notificationResultMatch[1], {
      status: input.status,
      error: input.error
    });
    return jsonResponse({ ok });
  }

  if (request.method === "POST" && taskResultMatch) {
    const input = (await request.json().catch(() => null)) as {
      taskDate?: string; title?: string; content?: string; attempt?: number;
      status?: ReminderResultStatus; error?: string;
    } | null;
    if (!input?.status || !resultStatuses.has(input.status)) return badRequest("无效的提醒结果。");
    const ok = await recordScheduledTaskReminder(env, user, taskResultMatch[1], { ...input, status: input.status });
    return ok ? jsonResponse({ ok }) : forbidden("只能上报当前儿童的任务提醒。");
  }

  return null;
}
