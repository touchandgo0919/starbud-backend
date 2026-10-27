import type { Env } from "../types";

/**
 * 照片和批改图片属于儿童作业原件，只有在儿童所属的每个家庭都由家长明确开启后
 * 才能发送给 AI 模型。没有设置记录时按“未授权”处理。
 */
export async function isMediaAnalysisAllowedForChild(env: Env, childId: string) {
  const row = await env.DB.prepare(
    `SELECT
      COUNT(*) AS family_count,
      COALESCE(SUM(CASE WHEN family_ai_settings.allow_media_analysis = 1 THEN 1 ELSE 0 END), 0) AS allowed_count
     FROM children
     INNER JOIN family_members ON family_members.user_id = children.child_user_id
     LEFT JOIN family_ai_settings ON family_ai_settings.family_id = family_members.family_id
     WHERE children.id = ?`
  ).bind(childId).first<{ family_count: number; allowed_count: number }>();
  const familyCount = Number(row?.family_count) || 0;
  return familyCount > 0 && Number(row?.allowed_count) === familyCount;
}

export async function getFamilyMediaAnalysisSetting(env: Env, familyId: string) {
  const row = await env.DB.prepare(
    "SELECT allow_media_analysis FROM family_ai_settings WHERE family_id = ? LIMIT 1"
  ).bind(familyId).first<{ allow_media_analysis: number }>();
  return Boolean(row?.allow_media_analysis);
}

export async function setFamilyMediaAnalysisSetting(
  env: Env,
  familyId: string,
  allowMediaAnalysis: boolean,
  updatedBy: string,
  updatedAt: string
) {
  await env.DB.prepare(
    `INSERT INTO family_ai_settings (family_id, allow_media_analysis, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(family_id) DO UPDATE SET
       allow_media_analysis = excluded.allow_media_analysis,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).bind(familyId, allowMediaAnalysis ? 1 : 0, updatedBy, updatedAt).run();
}
