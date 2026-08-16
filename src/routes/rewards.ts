import { badRequest, jsonResponse, notFound, unauthorized } from "../http";
import { ensureDefaultUsers } from "../db/seed";
import { getAuthUser } from "../services/auth";
import { confirmRewardRedemption, deleteFamilyReward, getRewardBalances, getRewardCenter, requestRewardRedemption, saveFamilyReward, updateRewardSettings } from "../services/rewards";
import type { Env } from "../types";

export async function handleRewards(request: Request, env: Env, url: URL) {
  if (!url.pathname.startsWith("/api/rewards")) return null;
  await ensureDefaultUsers(env);
  const user = await getAuthUser(request, env);
  if (!user) return unauthorized();
  try {
    if (request.method === "GET" && url.pathname === "/api/rewards") {
      return jsonResponse({ center: await getRewardCenter(env, user, url.searchParams.get("childId") || undefined) });
    }
    if (request.method === "GET" && url.pathname === "/api/rewards/balances") {
      return jsonResponse({ balances: await getRewardBalances(env, user) });
    }
    if (request.method === "PUT" && url.pathname === "/api/rewards/settings") {
      const input = await request.json() as Record<string, unknown>;
      const familyId = String(input.familyId || ""); if (!familyId) return badRequest("请选择家庭。");
      await updateRewardSettings(env, user, familyId, input); return jsonResponse({ updated: true });
    }
    if (request.method === "POST" && url.pathname === "/api/rewards/catalog") {
      const input = await request.json() as Record<string, unknown>; const familyId = String(input.familyId || "");
      if (!familyId) return badRequest("请选择家庭。");
      return jsonResponse({ id: await saveFamilyReward(env, user, familyId, input) }, { status: 201 });
    }
    const catalog = url.pathname.match(/^\/api\/rewards\/catalog\/([^/]+)$/);
    if (catalog && request.method === "PATCH") {
      const input = await request.json() as Record<string, unknown>; const familyId = String(input.familyId || "");
      if (!familyId) return badRequest("请选择家庭。");
      await saveFamilyReward(env, user, familyId, input, catalog[1]); return jsonResponse({ updated: true });
    }
    if (catalog && request.method === "DELETE") {
      const familyId = url.searchParams.get("familyId") || "";
      if (!familyId) return badRequest("请选择家庭。");
      await deleteFamilyReward(env, user, familyId, catalog[1]); return jsonResponse({ deleted: true });
    }
    if (request.method === "POST" && url.pathname === "/api/rewards/redemptions") {
      const input = await request.json() as { rewardId?: string; note?: string };
      if (!input.rewardId) return badRequest("请选择奖励。");
      return jsonResponse({ id: await requestRewardRedemption(env, user, input.rewardId, input.note) }, { status: 201 });
    }
    const confirmation = url.pathname.match(/^\/api\/rewards\/redemptions\/([^/]+)\/confirm$/);
    if (confirmation && request.method === "POST") {
      const input = await request.json() as { approved?: boolean };
      await confirmRewardRedemption(env, user, confirmation[1], Boolean(input.approved)); return jsonResponse({ updated: true });
    }
  } catch (error) { return badRequest(error instanceof Error ? error.message : "奖励操作失败。"); }
  return notFound();
}
