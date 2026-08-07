import type {
  AiAnalysisSnapshotDto,
  AiHomeOverviewDto,
  AiModelAnalysisContent,
  AuthUser,
  ChildNextStepDto,
  Env,
  TaskDto
} from "../types";
import { localTimestamp, randomId } from "../utils";
import { getAiHomeOverview } from "./ai-overview";
import { createAiResponse, getAiConfig, isAiConfigured } from "./ai";
import { childIdForUser } from "./children";
import { getTodayTasksForUser, todayKey } from "./tasks";

interface AnalysisChildRow {
  child_id: string;
  child_name: string;
  user_id: string;
  username: string;
  display_name: string | null;
}

interface AnalysisResultRow {
  child_id: string;
  child_name: string;
  analysis_date: string;
  period_days: number;
  model: string;
  result_json: string;
  generated_at: string;
}

const ANALYSIS_PERIOD_DAYS = 28;
const DEFAULT_ANALYSIS_HOUR = 4;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["parentSummary", "childNextStep"],
  properties: {
    parentSummary: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description"],
      properties: {
        title: { type: "string", maxLength: 30 },
        description: { type: "string", maxLength: 120 }
      }
    },
    childNextStep: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description"],
      properties: {
        title: { type: "string", maxLength: 24 },
        description: { type: "string", maxLength: 80 }
      }
    }
  }
};

function limitedText(value: unknown, fallback: string, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function normalizeModelResult(value: unknown, overview: AiHomeOverviewDto): AiModelAnalysisContent {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const parent = result.parentSummary && typeof result.parentSummary === "object"
    ? result.parentSummary as Record<string, unknown>
    : {};
  const child = result.childNextStep && typeof result.childNextStep === "object"
    ? result.childNextStep as Record<string, unknown>
    : {};
  return {
    parentSummary: {
      title: limitedText(parent.title, overview.summary.title, 30),
      description: limitedText(parent.description, overview.summary.description, 120)
    },
    childNextStep: {
      title: limitedText(child.title, "先完成眼前的一小步", 24),
      description: limitedText(child.description, "按提醒时间开始，完成后记得提交。", 80)
    }
  };
}

export function extractAiResponseText(response: unknown) {
  if (!response || typeof response !== "object") return "";
  const body = response as Record<string, unknown>;
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return "";
  for (const output of body.output) {
    if (!output || typeof output !== "object") continue;
    const content = (output as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
        return String((item as Record<string, unknown>).text);
      }
    }
  }
  return "";
}

async function analyzeOverview(env: Env, overview: AiHomeOverviewDto) {
  const response = await createAiResponse(env, {
    instructions: [
      "你是家庭儿童习惯助手，只分析任务执行数据。",
      "不要评价儿童能力、性格、态度、心理或健康，不做诊断。",
      "给家长的摘要应客观并说明变化；给儿童的建议只包含一个容易执行的下一步。",
      "不要承诺奖励，不要修改任务，不要输出 JSON 之外的内容。"
    ].join("\n"),
    input: JSON.stringify({
      period: overview.period,
      dataStatus: overview.dataStatus,
      confidence: overview.confidence,
      metrics: overview.metrics,
      trend: overview.trend,
      ruleInsights: overview.insights.map((item) => ({ title: item.title, summary: item.summary }))
    }),
    maxOutputTokens: 420,
    text: {
      format: {
        type: "json_schema",
        name: "starbud_daily_analysis",
        strict: true,
        schema: outputSchema
      }
    }
  });
  const text = extractAiResponseText(response);
  if (!text) throw new Error("模型未返回分析内容。");
  return normalizeModelResult(JSON.parse(text), overview);
}

async function listAnalysisChildren(env: Env) {
  const result = await env.DB.prepare(
    `SELECT
      children.id AS child_id,
      children.name AS child_name,
      users.id AS user_id,
      users.username,
      users.display_name
     FROM children
     INNER JOIN users ON users.id = children.child_user_id
     WHERE users.active = 1
     ORDER BY children.id ASC`
  ).all<AnalysisChildRow>();
  return result.results;
}

async function hasCompletedAnalysis(env: Env, childId: string, analysisDate: string) {
  const row = await env.DB.prepare(
    `SELECT id FROM ai_analysis_results
     WHERE child_id = ? AND analysis_date = ? AND period_days = ? AND status = 'completed'
     LIMIT 1`
  ).bind(childId, analysisDate, ANALYSIS_PERIOD_DAYS).first<{ id: string }>();
  return Boolean(row);
}

async function saveAnalysisState(
  env: Env,
  input: {
    childId: string;
    analysisDate: string;
    model: string;
    status: "running" | "completed" | "failed";
    result?: AiModelAnalysisContent;
    error?: string;
  }
) {
  const now = localTimestamp();
  await env.DB.prepare(
    `INSERT INTO ai_analysis_results (
      id, child_id, analysis_date, period_days, status, model,
      result_json, error_message, generated_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(child_id, analysis_date, period_days) DO UPDATE SET
      status = excluded.status,
      model = excluded.model,
      result_json = excluded.result_json,
      error_message = excluded.error_message,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at`
  ).bind(
    randomId("analysis"),
    input.childId,
    input.analysisDate,
    ANALYSIS_PERIOD_DAYS,
    input.status,
    input.model,
    JSON.stringify(input.result || {}),
    input.error?.slice(0, 500) || null,
    now,
    now
  ).run();
}

export function shouldRunDailyAiAnalysis(env: Env, date = new Date()) {
  const timestamp = localTimestamp(date);
  const hour = Number(env.AI_ANALYSIS_HOUR ?? DEFAULT_ANALYSIS_HOUR);
  return Number(timestamp.slice(11, 13)) === hour && timestamp.slice(14, 16) === "00";
}

export async function generateDailyAiAnalyses(env: Env, analysisDate = todayKey(env)) {
  if (!isAiConfigured(env)) return { generated: 0, failed: 0, skipped: 0, notConfigured: true };
  const model = getAiConfig(env).model;
  const children = await listAnalysisChildren(env);
  let generated = 0;
  let failed = 0;
  let skipped = 0;

  for (const child of children) {
    if (await hasCompletedAnalysis(env, child.child_id, analysisDate)) {
      skipped += 1;
      continue;
    }
    await saveAnalysisState(env, {
      childId: child.child_id,
      analysisDate,
      model,
      status: "running"
    });
    try {
      const user: AuthUser = {
        id: child.user_id,
        username: child.username,
        displayName: child.display_name || child.username,
        role: "child"
      };
      const overview = await getAiHomeOverview(env, user, {
        childId: child.child_id,
        days: ANALYSIS_PERIOD_DAYS
      });
      const result = await analyzeOverview(env, overview);
      await saveAnalysisState(env, {
        childId: child.child_id,
        analysisDate,
        model,
        status: "completed",
        result
      });
      generated += 1;
    } catch (error) {
      await saveAnalysisState(env, {
        childId: child.child_id,
        analysisDate,
        model,
        status: "failed",
        error: error instanceof Error ? error.message : "模型分析失败。"
      });
      failed += 1;
    }
  }

  return { generated, failed, skipped, notConfigured: false };
}

export async function getLatestAiAnalysis(env: Env, childId: string) {
  const row = await env.DB.prepare(
    `SELECT
      ai_analysis_results.child_id,
      children.name AS child_name,
      ai_analysis_results.analysis_date,
      ai_analysis_results.period_days,
      ai_analysis_results.model,
      ai_analysis_results.result_json,
      ai_analysis_results.generated_at
     FROM ai_analysis_results
     INNER JOIN children ON children.id = ai_analysis_results.child_id
     WHERE ai_analysis_results.child_id = ? AND ai_analysis_results.status = 'completed'
     ORDER BY ai_analysis_results.analysis_date DESC, ai_analysis_results.generated_at DESC
     LIMIT 1`
  ).bind(childId).first<AnalysisResultRow>();
  if (!row) return null;
  try {
    return {
      childId: row.child_id,
      childName: row.child_name,
      analysisDate: row.analysis_date,
      periodDays: row.period_days,
      model: row.model,
      generatedAt: row.generated_at,
      result: JSON.parse(row.result_json) as AiModelAnalysisContent
    } satisfies AiAnalysisSnapshotDto;
  } catch {
    return null;
  }
}

function taskPriority(task: TaskDto) {
  if (task.needsRevision) return 0;
  if (task.reviewStatus === "pending_review") return 3;
  if (task.claimedAt && task.status !== "completed") return 1;
  if (!task.claimedAt && task.status !== "completed") return 2;
  return 4;
}

function buildRuleNextStep(tasks: TaskDto[]): ChildNextStepDto {
  const sorted = [...tasks].sort((left, right) => taskPriority(left) - taskPriority(right) || left.scheduleTime.localeCompare(right.scheduleTime));
  const task = sorted[0];
  if (!task) {
    return { title: "今天没有待办任务", description: "可以整理一下书桌，等新的任务安排。", actionLabel: "查看任务", taskId: null, taskDate: null, stage: "rest", source: "rules", generatedAt: null };
  }
  if (task.needsRevision) {
    return { title: `修改“${task.title}”`, description: "先看看家长的批改内容，再重新提交附件。", actionLabel: "去修改", taskId: task.id, taskDate: task.occurrenceDate, stage: "revise", source: "rules", generatedAt: null };
  }
  if (task.reviewStatus === "pending_review") {
    return { title: "作业已经提交", description: "正在等待家长批改，可以先做下一件事。", actionLabel: "查看提交", taskId: task.id, taskDate: task.occurrenceDate, stage: "waiting", source: "rules", generatedAt: null };
  }
  if (task.claimedAt && task.status !== "completed") {
    return { title: `继续“${task.title}”`, description: task.requiresPhotoUpload ? "完成后拍照或录音，至少提交一种附件。" : "完成后点击确认，让家长看到进度。", actionLabel: "继续任务", taskId: task.id, taskDate: task.occurrenceDate, stage: "continue", source: "rules", generatedAt: null };
  }
  if (!task.claimedAt && task.status !== "completed") {
    return { title: `先领取“${task.title}”`, description: `${task.scheduleTime} 提醒，领取后就可以开始。`, actionLabel: "去领取", taskId: task.id, taskDate: task.occurrenceDate, stage: "claim", source: "rules", generatedAt: null };
  }
  return { title: "今天的任务完成了", description: "做得不错，可以回顾一下今天最顺利的一步。", actionLabel: "查看记录", taskId: task.id, taskDate: task.occurrenceDate, stage: "complete", source: "rules", generatedAt: null };
}

export async function getChildNextStep(env: Env, user: AuthUser, providedTasks?: TaskDto[]) {
  const childId = await childIdForUser(env, user);
  if (!childId) return buildRuleNextStep([]);
  const [tasks, snapshot] = await Promise.all([
    providedTasks ? Promise.resolve(providedTasks) : getTodayTasksForUser(env, user),
    getLatestAiAnalysis(env, childId)
  ]);
  const guidance = buildRuleNextStep(tasks);
  if (
    !snapshot ||
    snapshot.analysisDate !== todayKey(env) ||
    !["claim", "continue"].includes(guidance.stage)
  ) return guidance;
  return {
    ...guidance,
    description: snapshot.result.childNextStep.description,
    source: "model" as const,
    generatedAt: snapshot.generatedAt
  };
}
