import { badRequest, jsonResponse, notFound, unauthorized } from "../http";
import { ensureDefaultUsers } from "../db/seed";
import { getAuthUser } from "../services/auth";
import {
  addFamilyMember,
  createFamily,
  deleteFamily,
  listFamilies,
  removeFamilyMember,
  renameFamily,
  updateFamilyMember
} from "../services/families";
import type { Env } from "../types";

export async function handleFamilies(request: Request, env: Env, url: URL) {
  if (!url.pathname.startsWith("/api/families")) {
    return null;
  }

  await ensureDefaultUsers(env);
  const user = await getAuthUser(request, env);

  if (!user) {
    return unauthorized();
  }

  if (request.method === "GET" && url.pathname === "/api/families") {
    return jsonResponse({ families: await listFamilies(env, user) });
  }

  if (request.method === "POST" && url.pathname === "/api/families") {
    const input = (await request.json().catch(() => null)) as { name?: string } | null;

    try {
      const family = await createFamily(env, user, input?.name);
      return jsonResponse({ family }, { status: 201 });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "家庭创建失败。");
    }
  }

  const memberMatch = url.pathname.match(/^\/api\/families\/([^/]+)\/members\/([^/]+)$/);

  if (memberMatch && request.method === "PATCH") {
    const input = (await request.json().catch(() => null)) as { relationship?: string } | null;

    try {
      const family = await updateFamilyMember(
        env,
        user,
        memberMatch[1],
        memberMatch[2],
        input?.relationship
      );
      return family ? jsonResponse({ family }) : notFound();
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "成员关系更新失败。");
    }
  }

  if (memberMatch && request.method === "DELETE") {
    try {
      const removed = await removeFamilyMember(env, user, memberMatch[1], memberMatch[2]);
      return removed ? jsonResponse({ removed: true }) : notFound();
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "成员移除失败。");
    }
  }

  const membersMatch = url.pathname.match(/^\/api\/families\/([^/]+)\/members$/);

  if (membersMatch && request.method === "POST") {
    const input = (await request.json().catch(() => null)) as {
      username?: string;
      relationship?: string;
    } | null;

    try {
      const family = await addFamilyMember(
        env,
        user,
        membersMatch[1],
        input?.username,
        input?.relationship
      );
      return jsonResponse({ family });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "成员添加失败。");
    }
  }

  const familyMatch = url.pathname.match(/^\/api\/families\/([^/]+)$/);

  if (familyMatch && request.method === "PATCH") {
    const input = (await request.json().catch(() => null)) as { name?: string } | null;

    try {
      const family = await renameFamily(env, user, familyMatch[1], input?.name);
      return family ? jsonResponse({ family }) : notFound();
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "家庭更新失败。");
    }
  }

  if (familyMatch && request.method === "DELETE") {
    const deleted = await deleteFamily(env, user, familyMatch[1]);
    return deleted ? jsonResponse({ deleted: true }) : notFound();
  }

  return null;
}
