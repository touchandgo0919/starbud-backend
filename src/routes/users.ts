import { badRequest, forbidden, jsonResponse, notFound, unauthorized } from "../http";
import { ensureDefaultUsers } from "../db/seed";
import { getAuthUser } from "../services/auth";
import { createUser, listUsers, updateUser } from "../services/users";
import type { Env, SaveUserInput } from "../types";

export async function handleUsers(request: Request, env: Env, url: URL) {
  if (!url.pathname.startsWith("/api/admin/users")) {
    return null;
  }

  await ensureDefaultUsers(env);
  const user = await getAuthUser(request, env);

  if (!user) {
    return unauthorized();
  }

  if (user.role !== "admin") {
    return forbidden("仅系统管理员可以配置用户。");
  }

  if (request.method === "GET" && url.pathname === "/api/admin/users") {
    return jsonResponse({ users: await listUsers(env) });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/users") {
    const input = (await request.json().catch(() => null)) as SaveUserInput | null;
    if (!input) {
      return badRequest("Invalid JSON body.");
    }

    try {
      const created = await createUser(env, user, input);
      return jsonResponse({ user: created }, { status: 201 });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "用户创建失败。");
    }
  }

  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) {
    const input = (await request.json().catch(() => null)) as SaveUserInput | null;
    if (!input) {
      return badRequest("Invalid JSON body.");
    }

    try {
      const updated = await updateUser(env, user, userMatch[1], input);
      return updated ? jsonResponse({ user: updated }) : notFound();
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "用户更新失败。");
    }
  }

  return null;
}
