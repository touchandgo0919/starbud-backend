import { randomId } from "../utils";
import type {
  AuthUser,
  Env,
  SubmissionDto,
  SubmissionPhotoDto,
  SubmissionPhotoRow,
  SubmissionRow
} from "../types";
import { childIdForUser, listChildren } from "./children";
import { getTodayTasks, todayKey } from "./tasks";

const allowedPhotoTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const maxPhotoBytes = 10 * 1024 * 1024;
const maxPhotoCount = 6;

function photoDto(row: SubmissionPhotoRow): SubmissionPhotoDto {
  return {
    id: row.id,
    url: `/api/submission-files/${row.id}?token=${encodeURIComponent(row.access_token)}`,
    contentType: row.content_type,
    byteSize: row.byte_size
  };
}

async function getSubmissionPhotos(env: Env, submissionId: string) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM task_submission_photos
     WHERE submission_id = ?
     ORDER BY created_at ASC`
  )
    .bind(submissionId)
    .all<SubmissionPhotoRow>();

  return result.results;
}

async function submissionDto(env: Env, row: SubmissionRow): Promise<SubmissionDto> {
  const photos = await getSubmissionPhotos(env, row.id);
  return {
    id: row.id,
    taskId: row.task_id,
    childId: row.child_id,
    taskDate: row.task_date,
    taskTitle: row.task_title,
    scheduleTime: row.schedule_time,
    note: row.note,
    status: row.status,
    photoCount: photos.length,
    photos: photos.map(photoDto),
    createdAt: row.created_at,
    submittedAt: row.submitted_at
  };
}

async function getSubmissionRow(env: Env, submissionId: string) {
  return env.DB.prepare(
    `SELECT
      task_submissions.*,
      tasks.title AS task_title,
      tasks.schedule_time AS schedule_time
     FROM task_submissions
     INNER JOIN tasks
      ON tasks.id = task_submissions.task_id
     WHERE task_submissions.id = ?
     LIMIT 1`
  )
    .bind(submissionId)
    .first<SubmissionRow>();
}

async function childIdForSubmissionUser(env: Env, user: AuthUser) {
  if (user.role !== "child") {
    throw new Error("仅儿童账号可以提交作业。");
  }

  const childId = await childIdForUser(env, user);
  if (!childId) {
    throw new Error("当前儿童账号尚未关联家庭成员。");
  }
  return childId;
}

export async function createSubmission(
  env: Env,
  user: AuthUser,
  taskId: string,
  noteValue?: string
) {
  const childId = await childIdForSubmissionUser(env, user);
  const taskDate = todayKey(env);
  const note = noteValue?.trim() || "";

  if (note.length > 500) {
    throw new Error("补充说明不能超过 500 个字。");
  }

  const task = (await getTodayTasks(env, childId)).find((item) => item.id === taskId);
  if (!task) {
    return null;
  }

  const id = randomId("submission");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_claims (id, task_id, child_id, task_date)
       VALUES (?, ?, ?, ?)`
    ).bind(randomId("claim"), taskId, childId, taskDate),
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_submissions
        (id, task_id, child_id, task_date, note, status)
       VALUES (?, ?, ?, ?, ?, 'draft')`
    ).bind(id, taskId, childId, taskDate, note)
  ]);

  const existing = await env.DB.prepare(
    `SELECT id, status
     FROM task_submissions
     WHERE task_id = ? AND child_id = ? AND task_date = ?
     LIMIT 1`
  )
    .bind(taskId, childId, taskDate)
    .first<{ id: string; status: "draft" | "submitted" }>();

  if (!existing) {
    throw new Error("提交单创建失败。");
  }

  if (existing.status === "draft") {
    await env.DB.prepare("UPDATE task_submissions SET note = ? WHERE id = ?")
      .bind(note, existing.id)
      .run();
  }

  const row = await getSubmissionRow(env, existing.id);
  return row ? submissionDto(env, row) : null;
}

export async function uploadSubmissionPhoto(
  env: Env,
  user: AuthUser,
  submissionId: string,
  photo: File
) {
  const childId = await childIdForSubmissionUser(env, user);
  const submission = await getSubmissionRow(env, submissionId);

  if (!submission || submission.child_id !== childId) {
    return null;
  }
  if (submission.status !== "draft") {
    throw new Error("作业已经提交，不能继续添加照片。");
  }
  if (!allowedPhotoTypes.has(photo.type)) {
    throw new Error("仅支持 JPG、PNG、WebP 或 HEIC 图片。");
  }
  if (!photo.size || photo.size > maxPhotoBytes) {
    throw new Error("单张照片不能超过 10MB。");
  }

  const photoCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM task_submission_photos WHERE submission_id = ?"
  )
    .bind(submissionId)
    .first<{ count: number }>();

  if ((photoCount?.count || 0) >= maxPhotoCount) {
    throw new Error("每次最多上传 6 张照片。");
  }

  const id = randomId("photo");
  const objectKey = `submissions/${childId}/${submissionId}/${id}`;
  const accessToken = randomId("file");

  await env.SUBMISSION_FILES.put(objectKey, photo.stream(), {
    httpMetadata: { contentType: photo.type }
  });

  try {
    await env.DB.prepare(
      `INSERT INTO task_submission_photos
        (id, submission_id, object_key, access_token, content_type, byte_size)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(id, submissionId, objectKey, accessToken, photo.type, photo.size)
      .run();
  } catch (error) {
    await env.SUBMISSION_FILES.delete(objectKey);
    throw error;
  }

  const row = await env.DB.prepare(
    "SELECT * FROM task_submission_photos WHERE id = ? LIMIT 1"
  )
    .bind(id)
    .first<SubmissionPhotoRow>();

  return row ? photoDto(row) : null;
}

export async function finalizeSubmission(env: Env, user: AuthUser, submissionId: string) {
  const childId = await childIdForSubmissionUser(env, user);
  const submission = await getSubmissionRow(env, submissionId);

  if (!submission || submission.child_id !== childId) {
    return null;
  }
  if (submission.status === "submitted") {
    return submissionDto(env, submission);
  }

  const photoCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM task_submission_photos WHERE submission_id = ?"
  )
    .bind(submissionId)
    .first<{ count: number }>();

  if (!photoCount?.count) {
    throw new Error("请至少上传一张作业照片。");
  }

  const submittedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_submissions
       SET status = 'submitted', submitted_at = ?
       WHERE id = ? AND status = 'draft'`
    ).bind(submittedAt, submissionId),
    env.DB.prepare(
      `INSERT INTO task_records (id, task_id, date, status, completed_at)
       VALUES (?, ?, ?, 'completed', ?)
       ON CONFLICT(task_id, date)
       DO UPDATE SET status = 'completed', completed_at = excluded.completed_at`
    ).bind(randomId("record"), submission.task_id, submission.task_date, submittedAt)
  ]);

  const updated = await getSubmissionRow(env, submissionId);
  return updated ? submissionDto(env, updated) : null;
}

export async function listSubmissions(
  env: Env,
  user: AuthUser,
  options: {
    date?: string;
    dateFrom?: string;
    dateTo?: string;
    keyword?: string;
    page: number;
    pageSize: number;
  }
) {
  const childIds = user.role === "child"
    ? [await childIdForUser(env, user)].filter((childId): childId is string => Boolean(childId))
    : (await listChildren(env, user)).map((child) => child.id);

  if (!childIds.length) return { submissions: [], total: 0 };

  const childPlaceholders = childIds.map(() => "?").join(", ");
  const conditions = [
    `task_submissions.child_id IN (${childPlaceholders})`,
    "task_submissions.status = 'submitted'"
  ];
  const values: Array<string | number> = [...childIds];

  if (options.date) {
    conditions.push("task_submissions.task_date = ?");
    values.push(options.date);
  }
  if (options.dateFrom && options.dateTo) {
    conditions.push("task_submissions.task_date BETWEEN ? AND ?");
    values.push(options.dateFrom, options.dateTo);
  }


  if (options.keyword) {
    conditions.push("LOWER(tasks.title) LIKE ?");
    values.push(`%${options.keyword.trim().toLowerCase()}%`);
  }

  const where = conditions.join(" AND ");
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM task_submissions
     INNER JOIN tasks ON tasks.id = task_submissions.task_id
     WHERE ${where}`
  )
    .bind(...values)
    .first<{ count: number }>();

  const result = await env.DB.prepare(
    `SELECT
      task_submissions.*,
      tasks.title AS task_title,
      tasks.schedule_time AS schedule_time
     FROM task_submissions
     INNER JOIN tasks
      ON tasks.id = task_submissions.task_id
     WHERE ${where}
     ORDER BY task_submissions.submitted_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...values, options.pageSize, (options.page - 1) * options.pageSize)
    .all<SubmissionRow>();

  return {
    submissions: await Promise.all(result.results.map((row) => submissionDto(env, row))),
    total: total?.count || 0
  };
}

export async function getSubmissionPhotoObject(
  env: Env,
  photoId: string,
  accessToken: string
) {
  const photo = await env.DB.prepare(
    `SELECT *
     FROM task_submission_photos
     WHERE id = ? AND access_token = ?
     LIMIT 1`
  )
    .bind(photoId, accessToken)
    .first<SubmissionPhotoRow>();

  if (!photo) {
    return null;
  }

  const object = await env.SUBMISSION_FILES.get(photo.object_key);
  return object ? { object, photo } : null;
}
