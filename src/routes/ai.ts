import { badRequest, forbidden, jsonResponse, unauthorized } from "../http";
import { getAiHomeOverview } from "../services/ai-overview";
import { getChildNextStep, getLatestAiAnalysis } from "../services/ai-analysis";
import { getAuthUser } from "../services/auth";
import { getChildHome } from "../services/child-home";
import type { Env } from "../types";

export async function handleAi(request: Request, env: Env, url: URL) {
  const isChildHome = url.pathname === "/api/child/home";
  if (!url.pathname.startsWith("/api/ai") && !isChildHome) return null;

  const user = await getAuthUser(request, env);
  if (!user) return unauthorized();
  if (request.method === "GET" && isChildHome) {
    if (user.role !== "child") return forbidden("儿童首页仅供儿童账号使用。");
    return jsonResponse({ home: await getChildHome(env, user) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/child-next-step") {
    if (user.role !== "child") return forbidden("下一步建议仅供儿童账号使用。");
    return jsonResponse({ nextStep: await getChildNextStep(env, user) });
  }

  if (user.role === "child") return forbidden("AI 成长观察仅供家长查看。");

  if (request.method === "GET" && url.pathname === "/api/ai/home-overview") {
    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;
    const days = Number(url.searchParams.get("days") || "28");
    if ((from || to) && (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
      return badRequest("自定义时间范围格式不正确。");
    }
    if (!from && !to && (!Number.isInteger(days) || days < 1 || days > 366)) return badRequest("days 必须在 1 到 366 之间。");
    try {
      const childId = url.searchParams.get("childId") || undefined;
      const overview = await getAiHomeOverview(env, user, {
        childId,
        days,
        from,
        to
      });
      return jsonResponse({
        overview: {
          ...overview,
          modelAnalysis: childId && days === 28 ? await getLatestAiAnalysis(env, childId) : null
        }
      });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "成长观察生成失败。");
    }
  }

  return null;
}
