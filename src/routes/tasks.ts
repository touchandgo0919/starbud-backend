import { badRequest, forbidden, jsonResponse, notFound, unauthorized } from "../http";
import { getAuthUser } from "../services/auth";
import { ensureDefaultUsers } from "../db/seed";
import {
  completeTaskForUser,
  claimTaskForUser,
  createTaskForUser,
  deleteTaskForUser,
  getTodayTasksForUser,
  listTasksForUser,
  updateTaskForUser
} from "../services/tasks";
import type { CreateTaskInput, Env } from "../types";

export async function handleTasks(request: Request, env: Env, url: URL) {
  if (!url.pathname.startsWith("/api/tasks")) {
    return null;
  }

  await ensureDefaultUsers(env);

  const user = await getAuthUser(request, env);

  if (!user) {
    return unauthorized();
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/today") {
    const childId = url.searchParams.get("childId") || undefined;
    return jsonResponse({ tasks: await getTodayTasksForUser(env, user, childId) });
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    return jsonResponse({
      tasks: await listTasksForUser(env, user, {
        childId: url.searchParams.get("childId") || undefined,
        status: url.searchParams.get("status") || undefined,
        keyword: url.searchParams.get("keyword") || undefined,
        repeatType: url.searchParams.get("repeatType") || undefined,
        date: url.searchParams.get("date") || undefined,
        dateFrom: url.searchParams.get("dateFrom") || undefined,
        dateTo: url.searchParams.get("dateTo") || undefined
      })
    });
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    if (user.role === "child") {
      return forbidden("仅家长或管理员可以创建任务。");
    }

    const input = (await request.json().catch(() => null)) as CreateTaskInput | null;

    if (!input) {
      return badRequest("Invalid JSON body.");
    }

    try {
      const task = await createTaskForUser(env, user, input);
      return jsonResponse({ task }, { status: 201 });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "Invalid task.");
    }
  }

  const completeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);

  if (request.method === "POST" && completeMatch) {
    const task = await completeTaskForUser(env, user, completeMatch[1]);

    if (!task) {
      return notFound();
    }

    return jsonResponse({ task });
  }

  const claimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/);

  if (request.method === "POST" && claimMatch) {
    try {
      const task = await claimTaskForUser(env, user, claimMatch[1]);
      return task ? jsonResponse({ task }) : notFound();
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "任务领取失败。");
    }
  }

  const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);

  if (request.method === "PATCH" && deleteMatch) {
    if (user.role === "child") {
      return forbidden("仅家长或管理员可以编辑任务。");
    }

    const input = (await request.json().catch(() => null)) as CreateTaskInput | null;
    if (!input) {
      return badRequest("Invalid JSON body.");
    }

    try {
      const task = await updateTaskForUser(env, user, deleteMatch[1], input);
      return task ? jsonResponse({ task }) : notFound();
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "Invalid task.");
    }
  }

  if (request.method === "DELETE" && deleteMatch) {
    const deleted = await deleteTaskForUser(env, user, deleteMatch[1]);

    if (!deleted) {
      return notFound();
    }

    return jsonResponse({ deleted: true });
  }

  return null;
}
