import { badRequest, jsonResponse, notFound, unauthorized } from "../http";
import { getAuthUser } from "../services/auth";
import { ensureDefaultUsers } from "../db/seed";
import {
  completeTaskForUser,
  createTaskForUser,
  deleteTaskForUser,
  getTodayTasksForUser,
  listTasksForUser
} from "../services/tasks";
import type { CreateTaskInput, Env } from "../types";

export async function handleTasks(request: Request, env: Env, url: URL) {
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
        repeatType: url.searchParams.get("repeatType") || undefined
      })
    });
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
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

  const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);

  if (request.method === "DELETE" && deleteMatch) {
    const deleted = await deleteTaskForUser(env, user, deleteMatch[1]);

    if (!deleted) {
      return notFound();
    }

    return jsonResponse({ deleted: true });
  }

  return null;
}
