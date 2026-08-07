import { badRequest, forbidden, jsonResponse, unauthorized } from "../http";
import { getAiHomeOverview } from "../services/ai-overview";
import { getAuthUser } from "../services/auth";
import type { Env } from "../types";

export async function handleAi(request: Request, env: Env, url: URL) {
  if (!url.pathname.startsWith("/api/ai")) return null;

  const user = await getAuthUser(request, env);
  if (!user) return unauthorized();
  if (user.role === "child") return forbidden("AI 成长观察仅供家长查看。");

  if (request.method === "GET" && url.pathname === "/api/ai/home-overview") {
    const days = Number(url.searchParams.get("days") || "28");
    if (days !== 7 && days !== 28) return badRequest("days 仅支持 7 或 28。");
    try {
      return jsonResponse({
        overview: await getAiHomeOverview(env, user, {
          childId: url.searchParams.get("childId") || undefined,
          days
        })
      });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "成长观察生成失败。");
    }
  }

  return null;
}
