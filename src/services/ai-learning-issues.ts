import type { AuthUser, Env, LearningIssueOverviewDto } from "../types";
import { localTimestamp, randomId } from "../utils";
import { createAiResponse, getAiConfig, isAiConfigured } from "./ai";
import { listChildren } from "./children";

type LearningIssueCategory = "concept" | "calculation" | "comprehension" | "method" | "expression" | "pronunciation" | "completeness" | "other";
type LearningIssueConfidence = "high" | "medium" | "low";

interface LearningIssue {
  topic: string;
  category: LearningIssueCategory;
  summary: string;
  evidence: string;
  confidence: LearningIssueConfidence;
}

interface LearningIssueResult {
  summary: string;
  issues: LearningIssue[];
}

interface AnalysisRow {
  id: string;
  review_round_id: string;
  submission_id: string;
  child_id: string;
  child_name: string;
  task_id: string;
  task_date: string;
  task_title: string;
  status: "pending" | "processing" | "completed" | "failed";
  result_json: string;
  reviewed_at: string;
  finalized_at: string | null;
}

interface PendingAnalysisRow extends AnalysisRow {
  photos_json: string;
  review_feedback: string;
}

interface StoredPhoto {
  object_key?: string;
  content_type?: string;
}

interface ReviewImageRow {
  object_key: string;
  content_type: string;
  byte_size: number;
}

const MAX_ANALYSES_PER_RUN = 2;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const categories = new Set<LearningIssueCategory>([
  "concept", "calculation", "comprehension", "method", "expression", "pronunciation", "completeness", "other"
]);

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "issues"],
  properties: {
    summary: { type: "string", maxLength: 160 },
    issues: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "category", "summary", "evidence", "confidence"],
        properties: {
          topic: { type: "string", maxLength: 30 },
          category: { type: "string", enum: [...categories] },
          summary: { type: "string", maxLength: 80 },
          evidence: { type: "string", maxLength: 100 },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        }
      }
    }
  }
};

function limitedText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function responseText(response: unknown) {
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

export function normalizeLearningIssueResult(value: unknown): LearningIssueResult {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawIssues = Array.isArray(source.issues) ? source.issues : [];
  const issues = rawIssues.flatMap((item): LearningIssue[] => {
    if (!item || typeof item !== "object") return [];
    const issue = item as Record<string, unknown>;
    const topic = limitedText(issue.topic, 30);
    const summary = limitedText(issue.summary, 80);
    if (!topic || !summary) return [];
    const category = categories.has(issue.category as LearningIssueCategory)
      ? issue.category as LearningIssueCategory
      : "other";
    const confidence = issue.confidence === "high" || issue.confidence === "medium" || issue.confidence === "low"
      ? issue.confidence
      : "low";
    return [{ topic, category, summary, evidence: limitedText(issue.evidence, 100), confidence }];
  }).slice(0, 6);
  return {
    summary: limitedText(source.summary, 160) || (issues.length ? "已根据家长批改记录整理本次历史问题。" : "本次批改未识别到可可靠归纳的问题。"),
    issues
  };
}

export async function queueLearningIssueAnalysis(env: Env, submissionId: string, reviewRoundId: string) {
  const row = await env.DB.prepare(
    `SELECT task_submissions.child_id, task_submissions.task_id, task_submissions.task_date,
      tasks.title AS task_title, submission_review_rounds.reviewed_at
     FROM submission_review_rounds
     INNER JOIN task_submissions ON task_submissions.id = submission_review_rounds.submission_id
     INNER JOIN tasks ON tasks.id = task_submissions.task_id
     WHERE submission_review_rounds.id = ? AND task_submissions.id = ?
     LIMIT 1`
  ).bind(reviewRoundId, submissionId).first<{
    child_id: string;
    task_id: string;
    task_date: string;
    task_title: string;
    reviewed_at: string;
  }>();
  if (!row) return false;
  const now = localTimestamp();
  await env.DB.prepare(
    `INSERT INTO ai_learning_issue_analyses (
      id, review_round_id, submission_id, child_id, task_id, task_date, task_title,
      status, model, result_json, error_message, reviewed_at, generated_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', '{}', NULL, ?, NULL, ?)
     ON CONFLICT(review_round_id) DO UPDATE SET
      status = 'pending', result_json = '{}', error_message = NULL,
      reviewed_at = excluded.reviewed_at, generated_at = NULL, updated_at = excluded.updated_at`
  ).bind(
    randomId("learning-issue"), reviewRoundId, submissionId, row.child_id, row.task_id,
    row.task_date, row.task_title, row.reviewed_at, now
  ).run();
  return true;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function imageContent(env: Env, rows: ReviewImageRow[]) {
  const content: Array<{ type: "input_image"; image_url: string; detail: "low" }> = [];
  let totalBytes = 0;
  for (const row of rows.slice(0, 4)) {
    if (!supportedImageTypes.has(row.content_type) || row.byte_size > MAX_IMAGE_BYTES || totalBytes + row.byte_size > MAX_TOTAL_IMAGE_BYTES) continue;
    const object = await env.SUBMISSION_FILES.get(row.object_key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    totalBytes += bytes.byteLength;
    content.push({ type: "input_image", image_url: `data:${row.content_type};base64,${bytesToBase64(bytes)}`, detail: "low" });
  }
  return content;
}

async function analyzePendingRow(env: Env, row: PendingAnalysisRow) {
  const reviewedImages = await env.DB.prepare(
    `SELECT object_key, content_type, byte_size
     FROM submission_review_images
     WHERE review_round_id = ?
     ORDER BY sequence ASC`
  ).bind(row.review_round_id).all<ReviewImageRow>();
  const originalPhotos = (() => {
    try {
      return (JSON.parse(row.photos_json || "[]") as StoredPhoto[]).flatMap((photo): ReviewImageRow[] =>
        photo.object_key && photo.content_type
          ? [{ object_key: photo.object_key, content_type: photo.content_type, byte_size: 0 }]
          : []
      );
    } catch {
      return [];
    }
  })();
  const imageRows = reviewedImages.results.length ? reviewedImages.results : originalPhotos;
  const images = await imageContent(env, imageRows.map((image) => ({
    ...image,
    byte_size: image.byte_size || MAX_IMAGE_BYTES
  })));
  const response = await createAiResponse(env, {
    instructions: [
      "你是家庭学习记录整理助手，在家长已经完成批改后归纳历史问题。",
      "不得替家长重新判分，不评价儿童能力、性格、态度、心理或健康。",
      "优先依据家长批改图中的标注和录音评价；没有明确证据时不要猜测。",
      "topic 使用简短、可聚合的知识点或技能名称，避免使用孩子姓名。",
      "confidence 为 low 的问题会被系统隐藏。没有可靠问题时返回空 issues。",
      "只输出符合 JSON Schema 的内容。"
    ].join("\n"),
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({
            taskTitle: row.task_title,
            taskDate: row.task_date,
            parentAudioFeedback: row.review_feedback || "未填写",
            note: "图片为家长已经完成的批改结果；只归纳其中明确指出的问题。"
          })
        },
        ...images
      ]
    }],
    maxOutputTokens: 700,
    text: { format: { type: "json_schema", name: "starbud_learning_issues", strict: true, schema: outputSchema } }
  });
  const text = responseText(response);
  if (!text) throw new Error("模型未返回历史问题分析。 ");
  return normalizeLearningIssueResult(JSON.parse(text));
}

export async function processPendingLearningIssueAnalyses(env: Env) {
  if (!isAiConfigured(env)) return { processed: 0, failed: 0, notConfigured: true };
  const result = await env.DB.prepare(
    `SELECT analyses.*, children.name AS child_name, task_submissions.finalized_at,
      submission_review_rounds.photos_json, submission_review_rounds.review_feedback
     FROM ai_learning_issue_analyses AS analyses
     INNER JOIN children ON children.id = analyses.child_id
     INNER JOIN task_submissions ON task_submissions.id = analyses.submission_id
     INNER JOIN submission_review_rounds ON submission_review_rounds.id = analyses.review_round_id
     WHERE analyses.status = 'pending'
     ORDER BY analyses.reviewed_at ASC
     LIMIT ?`
  ).bind(MAX_ANALYSES_PER_RUN).all<PendingAnalysisRow>();
  let processed = 0;
  let failed = 0;
  const model = getAiConfig(env).model;
  for (const row of result.results) {
    const startedAt = localTimestamp();
    await env.DB.prepare(
      "UPDATE ai_learning_issue_analyses SET status = 'processing', model = ?, updated_at = ? WHERE id = ?"
    ).bind(model, startedAt, row.id).run();
    try {
      const analysis = await analyzePendingRow(env, row);
      const completedAt = localTimestamp();
      await env.DB.prepare(
        `UPDATE ai_learning_issue_analyses
         SET status = 'completed', result_json = ?, error_message = NULL, generated_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(JSON.stringify(analysis), completedAt, completedAt, row.id).run();
      processed += 1;
    } catch (error) {
      await env.DB.prepare(
        `UPDATE ai_learning_issue_analyses SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`
      ).bind(error instanceof Error ? error.message.slice(0, 500) : "历史问题分析失败。", localTimestamp(), row.id).run();
      failed += 1;
    }
  }
  return { processed, failed, notConfigured: false };
}

function topicKey(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, "");
}

export async function getLearningIssueOverview(
  env: Env,
  user: AuthUser,
  options: { childId?: string; from: string; to: string }
): Promise<LearningIssueOverviewDto> {
  const children = await listChildren(env, user);
  const selected = options.childId ? children.find((child) => child.id === options.childId) : null;
  if (options.childId && !selected) throw new Error("无权查看该成员的数据。");
  const childIds = selected ? [selected.id] : children.map((child) => child.id);
  if (!childIds.length) return { status: "empty", analyzedReviews: 0, analyzingReviews: 0, issueCount: 0, summary: "暂无可分析的批改记录。", recurring: [], recent: [], resolved: [] };
  const placeholders = childIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT analyses.*, children.name AS child_name, task_submissions.finalized_at
     FROM ai_learning_issue_analyses AS analyses
     INNER JOIN children ON children.id = analyses.child_id
     INNER JOIN task_submissions ON task_submissions.id = analyses.submission_id
     WHERE analyses.child_id IN (${placeholders}) AND analyses.task_date BETWEEN ? AND ?
     ORDER BY analyses.reviewed_at DESC`
  ).bind(...childIds, options.from, options.to).all<AnalysisRow>();
  const completed = rows.results.flatMap((row) => {
    if (row.status !== "completed") return [];
    try {
      return [{ row, result: normalizeLearningIssueResult(JSON.parse(row.result_json)) }];
    } catch {
      return [];
    }
  });
  const visible = completed.flatMap(({ row, result }) => result.issues
    .filter((issue) => issue.confidence !== "low")
    .map((issue) => ({ row, issue, resolved: Boolean(row.finalized_at && row.finalized_at >= row.reviewed_at) })));
  const grouped = new Map<string, { topic: string; category: LearningIssueCategory; count: number; lastSeenAt: string; childName: string }>();
  for (const item of visible) {
    const key = `${item.row.child_id}:${topicKey(item.issue.topic)}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { topic: item.issue.topic, category: item.issue.category, count: 1, lastSeenAt: item.row.reviewed_at, childName: item.row.child_name });
  }
  const recurring = [...grouped.values()].filter((item) => item.count >= 2).sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt)).slice(0, 5);
  const recent = visible.slice(0, 6).map(({ row, issue, resolved }) => ({
    topic: issue.topic,
    category: issue.category,
    summary: issue.summary,
    taskTitle: row.task_title,
    taskDate: row.task_date,
    childName: row.child_name,
    reviewedAt: row.reviewed_at,
    resolved
  }));
  const resolved = visible.filter((item) => item.resolved).slice(0, 4).map(({ row, issue }) => ({
    topic: issue.topic,
    taskTitle: row.task_title,
    taskDate: row.task_date,
    childName: row.child_name,
    resolvedAt: row.finalized_at || row.reviewed_at
  }));
  const analyzingReviews = rows.results.filter((row) => row.status === "pending" || row.status === "processing").length;
  const lead = recurring[0] || [...grouped.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  return {
    status: visible.length ? "ready" : analyzingReviews ? "analyzing" : "empty",
    analyzedReviews: completed.length,
    analyzingReviews,
    issueCount: visible.length,
    summary: lead
      ? `${lead.topic}${lead.count >= 2 ? `在本期出现 ${lead.count} 次` : "是本期最近记录的问题"}，可结合后续订正结果继续观察。`
      : analyzingReviews ? "家长批改已保存，正在自动整理历史问题。" : "本期批改记录中暂未发现可可靠归纳的问题。",
    recurring,
    recent,
    resolved
  };
}
