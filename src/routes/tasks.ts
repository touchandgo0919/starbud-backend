import { badRequest, jsonResponse, notFound } from "../http";
import { completeTask, createTask, getTodayTasks } from "../services/tasks";
import type { CreateTaskInput, Env } from "../types";

export async function handleTasks(request: Request, env: Env, url: URL) {
  if (request.method === "GET" && url.pathname === "/api/tasks/today") {
    const childId = url.searchParams.get("childId") || undefined;
    return jsonResponse({ tasks: await getTodayTasks(env, childId) });
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const input = (await request.json().catch(() => null)) as CreateTaskInput | null;

    if (!input) {
      return badRequest("Invalid JSON body.");
    }

    try {
      const task = await createTask(env, input);
      return jsonResponse({ task }, { status: 201 });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "Invalid task.");
    }
  }

  const completeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);

  if (request.method === "POST" && completeMatch) {
    const task = await completeTask(env, completeMatch[1]);

    if (!task) {
      return notFound();
    }

    return jsonResponse({ task });
  }

  return null;
}
