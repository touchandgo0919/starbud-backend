import { localTimestamp, randomId } from "../utils";
import type {
  AuthUser,
  Env,
  NotificationDto,
  NotificationRow,
  SubmissionDto,
  SubmissionAudioDto,
  SubmissionAudioRow,
  SubmissionPhotoDto,
  SubmissionPhotoRow,
  SubmissionReviewRoundDto,
  SubmissionRow
} from "../types";
import { childIdForUser, listChildren } from "./children";
import { getTaskById, todayKey } from "./tasks";

const allowedPhotoTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const maxPhotoBytes = 10 * 1024 * 1024;
const maxPhotoCount = 8;
const allowedAudioTypes = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac", "audio/webm"]);
const maxAudioBytes = 5 * 1024 * 1024;
const maxAudioDurationMs = 3 * 60 * 1000;

function photoDto(row: SubmissionPhotoRow): SubmissionPhotoDto {
  return {
    id: row.id,
    url: `/api/submission-files/${row.id}?token=${encodeURIComponent(row.access_token)}`,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdAt: row.created_at
  };
}

function audioDto(row: SubmissionAudioRow): SubmissionAudioDto {
  return {
    id: row.id,
    url: `/api/submission-audio/${row.id}?token=${encodeURIComponent(row.access_token)}`,
    contentType: row.content_type,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    createdAt: row.created_at
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

async function getSubmissionAudio(env: Env, submissionId: string) {
  return env.DB.prepare(
    "SELECT * FROM task_submission_audios WHERE submission_id = ? LIMIT 1"
  ).bind(submissionId).first<SubmissionAudioRow>();
}

interface ReviewRoundRow {
  id: string;
  submission_id: string;
  sequence: number;
  note: string;
  review_feedback: string;
  photos_json: string;
  audio_json: string;
  review_object_key: string;
  review_access_token: string;
  review_content_type: string;
  submitted_at: string | null;
  reviewed_at: string;
}

interface ReviewRoundImageRow {
  id: string;
  review_round_id: string;
  sequence: number;
  object_key: string;
  access_token: string;
  content_type: string;
  byte_size: number;
  created_at: string;
}

function reviewRoundPhotos(round: ReviewRoundRow): SubmissionPhotoDto[] {
  const photos = JSON.parse(round.photos_json) as SubmissionPhotoRow[];
  return photos.map((photo, index) => ({
    id: photo.id,
    url: `/api/review-round-photos/${round.id}/${index}?token=${encodeURIComponent(round.review_access_token)}`,
    contentType: photo.content_type,
    byteSize: photo.byte_size,
    createdAt: photo.created_at
  }));
}

function reviewRoundAudios(round: ReviewRoundRow): SubmissionAudioDto[] {
  try {
    return (JSON.parse(round.audio_json || "[]") as SubmissionAudioRow[]).map((audio, index) => ({
      id: audio.id,
      url: `/api/review-round-audios/${round.id}/${index}?token=${encodeURIComponent(round.review_access_token)}`,
      contentType: audio.content_type,
      byteSize: audio.byte_size,
      durationMs: audio.duration_ms,
      createdAt: audio.created_at
    }));
  } catch {
    return [];
  }
}

async function reviewRoundImages(env: Env, round: ReviewRoundRow): Promise<SubmissionPhotoDto[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM submission_review_images
     WHERE review_round_id = ?
     ORDER BY sequence ASC`
  ).bind(round.id).all<ReviewRoundImageRow>();
  if (!result.results.length) {
    if (!round.review_object_key || !round.review_access_token) return [];
    return [{
      id: `legacy-${round.id}`,
      url: `/api/review-round-files/${round.id}?token=${encodeURIComponent(round.review_access_token)}`,
      contentType: round.review_content_type,
      byteSize: 0,
      createdAt: round.reviewed_at
    }];
  }
  return result.results.map((image) => ({
    id: image.id,
    url: `/api/review-round-images/${image.id}?token=${encodeURIComponent(image.access_token)}`,
    contentType: image.content_type,
    byteSize: image.byte_size,
    createdAt: image.created_at
  }));
}

async function getSubmissionReviewRounds(env: Env, submissionId: string): Promise<SubmissionReviewRoundDto[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM submission_review_rounds
     WHERE submission_id = ?
     ORDER BY sequence ASC`
  ).bind(submissionId).all<ReviewRoundRow>();

  return Promise.all(result.results.map(async (round) => ({
    id: round.id,
    sequence: round.sequence,
    note: round.note,
    feedback: round.review_feedback || "",
    photos: reviewRoundPhotos(round),
    audios: reviewRoundAudios(round),
    reviewImages: await reviewRoundImages(env, round),
    reviewImageUrl: round.review_object_key
      ? `/api/review-round-files/${round.id}?token=${encodeURIComponent(round.review_access_token)}`
      : "",
    submittedAt: round.submitted_at,
    reviewedAt: round.reviewed_at
  })));
}

async function submissionDto(env: Env, row: SubmissionRow): Promise<SubmissionDto> {
  const photos = await getSubmissionPhotos(env, row.id);
  const audio = await getSubmissionAudio(env, row.id);
  const savedReviewRounds = await getSubmissionReviewRounds(env, row.id);
  // 0009 迁移前的批改仅保存了最后一张批改图。将其转换为首轮记录，
  // 让历史任务也能使用统一的分组详情布局。
  const reviewRounds = savedReviewRounds.length || !row.review_id || !row.review_access_token
    ? savedReviewRounds
    : [{
      id: `legacy-${row.id}`,
      sequence: 1,
      note: row.note,
      feedback: "",
      photos: photos.map(photoDto),
      audios: [],
      reviewImages: [{
        id: `legacy-${row.id}`,
        url: `/api/review-files/${row.review_id}?token=${encodeURIComponent(row.review_access_token)}`,
        contentType: row.review_content_type || "image/png",
        byteSize: 0,
        createdAt: row.reviewed_at || row.submitted_at || row.created_at
      }],
      reviewImageUrl: `/api/review-files/${row.review_id}?token=${encodeURIComponent(row.review_access_token)}`,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at || row.submitted_at || row.created_at
    }];
  return {
    id: row.id,
    taskId: row.task_id,
    childId: row.child_id,
    childName: row.child_name || "",
    taskDate: row.task_date,
    taskTitle: row.task_title,
    scheduleTime: row.schedule_time,
    note: row.note,
    status: row.status,
    photoCount: photos.length,
    photos: photos.map(photoDto),
    audio: audio ? audioDto(audio) : null,
    audioFeedback: row.audio_feedback || "",
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    finalizedAt: row.finalized_at,
    reviewImageUrl: row.review_id && row.review_access_token
      ? `/api/review-files/${row.review_id}?token=${encodeURIComponent(row.review_access_token)}`
      : null,
    reviewRounds
  };
}

async function getSubmissionRow(env: Env, submissionId: string) {
  return env.DB.prepare(
    `SELECT
      task_submissions.*,
      tasks.title AS task_title,
      tasks.schedule_time AS schedule_time,
      tasks.require_photo_upload AS require_photo_upload,
      children.name AS child_name
     FROM task_submissions
     INNER JOIN tasks
      ON tasks.id = task_submissions.task_id
     INNER JOIN children
      ON children.id = task_submissions.child_id
     WHERE task_submissions.id = ?
     LIMIT 1`
  )
    .bind(submissionId)
    .first<SubmissionRow>();
}

async function getSubmissionRowForDeletion(env: Env, submissionId: string) {
  return env.DB.prepare(
    `SELECT
      task_submissions.*,
      COALESCE(tasks.title, '已删除任务') AS task_title,
      COALESCE(tasks.schedule_time, '') AS schedule_time,
      COALESCE(tasks.require_photo_upload, 1) AS require_photo_upload,
      children.name AS child_name
     FROM task_submissions
     LEFT JOIN tasks
      ON tasks.id = task_submissions.task_id
     INNER JOIN children
      ON children.id = task_submissions.child_id
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
  noteValue?: string,
  taskDate?: string
) {
  const childId = await childIdForSubmissionUser(env, user);
  const date = taskDate || todayKey(env);
  const note = noteValue?.trim() || "";

  if (note.length > 500) {
    throw new Error("补充说明不能超过 500 个字。");
  }

  const task = await getTaskById(env, taskId, date, true);
  if (!task || task.childId !== childId) {
    return null;
  }
  if (!task.requiresPhotoUpload) {
    throw new Error("该任务无需提交附件，领取后请等待家长确认。");
  }

  const id = randomId("submission");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_claims (id, task_id, child_id, task_date, claimed_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(randomId("claim"), taskId, childId, date, localTimestamp()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_submissions
        (id, task_id, child_id, task_date, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`
    ).bind(id, taskId, childId, date, note, localTimestamp())
  ]);

  const existing = await env.DB.prepare(
    `SELECT id, status
     FROM task_submissions
     WHERE task_id = ? AND child_id = ? AND task_date = ?
     LIMIT 1`
  )
    .bind(taskId, childId, date)
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
  if (!submission.require_photo_upload) {
    throw new Error("该任务无需提交附件，领取后请等待家长确认。");
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
    throw new Error("每次最多上传 8 张照片。");
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
        (id, submission_id, object_key, access_token, content_type, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, submissionId, objectKey, accessToken, photo.type, photo.size, localTimestamp())
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

export async function uploadSubmissionAudio(
  env: Env,
  user: AuthUser,
  submissionId: string,
  audio: File,
  durationMs: number
) {
  const childId = await childIdForSubmissionUser(env, user);
  const submission = await getSubmissionRow(env, submissionId);

  if (!submission || submission.child_id !== childId) return null;
  if (!submission.require_photo_upload) throw new Error("该任务无需提交附件，领取后请等待家长确认。");
  if (submission.status !== "draft") throw new Error("作业已经提交，不能继续修改录音。");
  if (!allowedAudioTypes.has(audio.type)) throw new Error("仅支持 MP3、M4A、AAC 或 WebM 录音。");
  if (!audio.size || audio.size > maxAudioBytes) throw new Error("录音文件不能超过 5MB。");
  if (!Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > maxAudioDurationMs) {
    throw new Error("录音时长需在 1 秒到 3 分钟之间。");
  }

  const previous = await getSubmissionAudio(env, submissionId);
  const id = randomId("audio");
  const objectKey = `submissions/${childId}/${submissionId}/${id}`;
  const accessToken = randomId("audio-file");

  await env.SUBMISSION_FILES.put(objectKey, audio.stream(), {
    httpMetadata: { contentType: audio.type }
  });

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM task_submission_audios WHERE submission_id = ?").bind(submissionId),
      env.DB.prepare(
        `INSERT INTO task_submission_audios
          (id, submission_id, object_key, access_token, content_type, byte_size, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, submissionId, objectKey, accessToken, audio.type, audio.size, durationMs, localTimestamp())
    ]);
  } catch (error) {
    await env.SUBMISSION_FILES.delete(objectKey);
    throw error;
  }

  if (previous) await env.SUBMISSION_FILES.delete(previous.object_key);
  const saved = await env.DB.prepare("SELECT * FROM task_submission_audios WHERE id = ? LIMIT 1")
    .bind(id).first<SubmissionAudioRow>();
  return saved ? audioDto(saved) : null;
}

export async function deleteSubmissionAudio(env: Env, user: AuthUser, submissionId: string) {
  const childId = await childIdForSubmissionUser(env, user);
  const submission = await getSubmissionRow(env, submissionId);
  if (!submission || submission.child_id !== childId) return false;
  if (submission.status !== "draft") throw new Error("作业已经提交，不能删除录音。");

  const audio = await getSubmissionAudio(env, submissionId);
  if (!audio) return false;
  await env.DB.prepare("DELETE FROM task_submission_audios WHERE id = ?").bind(audio.id).run();
  await env.SUBMISSION_FILES.delete(audio.object_key);
  return true;
}

export async function finalizeSubmission(env: Env, user: AuthUser, submissionId: string) {
  const childId = await childIdForSubmissionUser(env, user);
  const submission = await getSubmissionRow(env, submissionId);

  if (!submission || submission.child_id !== childId) {
    return null;
  }
  if (!submission.require_photo_upload) {
    throw new Error("该任务无需提交附件，不能提交作业。");
  }
  if (submission.status === "submitted") {
    return submissionDto(env, submission);
  }

  const photoCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM task_submission_photos WHERE submission_id = ?"
  )
    .bind(submissionId)
    .first<{ count: number }>();

  const audio = await getSubmissionAudio(env, submissionId);
  if (!photoCount?.count && !audio) {
    throw new Error("请至少提交一张照片或一段录音。");
  }

  const submittedAt = localTimestamp();
  await env.DB.prepare(
    `UPDATE task_submissions
     SET status = 'submitted', submitted_at = ?,
         review_id = NULL, review_object_key = NULL, review_access_token = NULL,
         review_content_type = NULL, review_byte_size = NULL,
         reviewed_at = NULL, finalized_at = NULL, audio_feedback = ''
     WHERE id = ? AND status = 'draft'`
  ).bind(submittedAt, submissionId).run();

  const updated = await getSubmissionRow(env, submissionId);
  return updated ? submissionDto(env, updated) : null;
}

export async function submitReview(
  env: Env,
  user: AuthUser,
  submissionId: string,
  inputImages: File[],
  replaceReviewImageId: string | null = null
) {
  if (user.role !== "parent" && user.role !== "admin") {
    throw new Error("仅家长或管理员可以提交批改。");
  }

  const submission = await getSubmissionRow(env, submissionId);
  if (!submission) return null;
  if (submission.status !== "submitted") {
    throw new Error("小朋友尚未提交作业，暂不能批改。");
  }

  if (user.role !== "admin") {
    const children = await listChildren(env, user);
    if (!children.some((child) => child.id === submission.child_id)) {
      return null;
    }
  }

  if (!inputImages.length) {
    throw new Error("请上传至少一张批改后的图片。");
  }
  if (inputImages.some((image) => !allowedPhotoTypes.has(image.type) || image.size > maxPhotoBytes)) {
    throw new Error("批改图片格式或大小不符合要求。");
  }

  const recipient = await env.DB.prepare(
    "SELECT child_user_id FROM children WHERE id = ? LIMIT 1"
  )
    .bind(submission.child_id)
    .first<{ child_user_id: string | null }>();
  if (!recipient?.child_user_id) {
    throw new Error("未找到儿童账号，无法发送通知。");
  }

  const reviewedAt = localTimestamp();

  // 重新批改直接编辑已存在的批改图：更新指定图片，而不是追加新图片。
  if (replaceReviewImageId) {
    if (inputImages.length !== 1) {
      throw new Error("重新批改时一次只能提交一张图片。");
    }

    const image = inputImages[0];
    const accessToken = randomId("review-file");

    if (replaceReviewImageId.startsWith("legacy-")) {
      const roundId = replaceReviewImageId.slice("legacy-".length);
      const round = await env.DB.prepare(
        `SELECT * FROM submission_review_rounds
         WHERE id = ? AND submission_id = ?
         LIMIT 1`
      ).bind(roundId, submissionId).first<ReviewRoundRow>();
      if (!round) return null;

      await env.SUBMISSION_FILES.put(round.review_object_key, image.stream(), {
        httpMetadata: { contentType: image.type }
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE submission_review_rounds
           SET review_access_token = ?, review_content_type = ?, reviewed_at = ?
           WHERE id = ?`
        ).bind(accessToken, image.type, reviewedAt, roundId),
        env.DB.prepare(
          `UPDATE task_submissions
           SET review_id = ?, review_object_key = ?, review_access_token = ?,
               review_content_type = ?, review_byte_size = ?, reviewed_at = ?
           WHERE id = ?`
        ).bind(submission.review_id || replaceReviewImageId, round.review_object_key, accessToken, image.type, image.size, reviewedAt, submissionId),
        env.DB.prepare(
          `INSERT INTO notifications
           (id, recipient_user_id, submission_id, type, title, content, created_at)
           VALUES (?, ?, ?, 'review_completed', '作业批改已更新', ?, ?)`
        ).bind(randomId("notification"), recipient.child_user_id, submissionId, `你的「${submission.task_title}」有 1 张批改图片已更新，快去看看吧！`, reviewedAt)
      ]);
    } else {
      const reviewImage = await env.DB.prepare(
        `SELECT submission_review_images.*
         FROM submission_review_images
         INNER JOIN submission_review_rounds
           ON submission_review_rounds.id = submission_review_images.review_round_id
         WHERE submission_review_images.id = ?
           AND submission_review_rounds.submission_id = ?
         LIMIT 1`
      ).bind(replaceReviewImageId, submissionId).first<ReviewRoundImageRow>();
      if (!reviewImage) return null;

      await env.SUBMISSION_FILES.put(reviewImage.object_key, image.stream(), {
        httpMetadata: { contentType: image.type }
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE submission_review_images
           SET access_token = ?, content_type = ?, byte_size = ?, created_at = ?
           WHERE id = ?`
        ).bind(accessToken, image.type, image.size, reviewedAt, replaceReviewImageId),
        env.DB.prepare(
          `UPDATE task_submissions
           SET review_id = ?, review_object_key = ?, review_access_token = ?,
               review_content_type = ?, review_byte_size = ?, reviewed_at = ?
           WHERE id = ?`
        ).bind(replaceReviewImageId, reviewImage.object_key, accessToken, image.type, image.size, reviewedAt, submissionId),
        env.DB.prepare(
          `INSERT INTO notifications
           (id, recipient_user_id, submission_id, type, title, content, created_at)
           VALUES (?, ?, ?, 'review_completed', '作业批改已更新', ?, ?)`
        ).bind(randomId("notification"), recipient.child_user_id, submissionId, `你的「${submission.task_title}」有 1 张批改图片已更新，快去看看吧！`, reviewedAt)
      ]);
    }

    const updated = await getSubmissionRow(env, submissionId);
    return updated ? submissionDto(env, updated) : null;
  }

  const photos = await getSubmissionPhotos(env, submissionId);
  const audio = await getSubmissionAudio(env, submissionId);
  const currentRound = submission.review_id
    ? await env.DB.prepare(
      `SELECT * FROM submission_review_rounds
       WHERE submission_id = ?
       ORDER BY sequence DESC
       LIMIT 1`
    ).bind(submissionId).first<ReviewRoundRow>()
    : null;
  const nextSequence = currentRound
    ? currentRound.sequence
    : (await env.DB.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM submission_review_rounds WHERE submission_id = ?")
      .bind(submissionId).first<{ sequence: number }>())?.sequence || 1;
  const firstImageSequence = currentRound
    ? (await env.DB.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM submission_review_images WHERE review_round_id = ?")
      .bind(currentRound.id).first<{ sequence: number }>())?.sequence || 1
    : 1;
  const roundId = currentRound?.id || randomId("round");
  const reviewImages = await Promise.all(inputImages.map(async (image) => {
    const reviewId = randomId("review");
    const accessToken = randomId("review-file");
    const objectKey = `reviews/${submission.child_id}/${submissionId}/${reviewId}`;
    await env.SUBMISSION_FILES.put(objectKey, image.stream(), {
      httpMetadata: { contentType: image.type }
    });
    return { reviewId, accessToken, objectKey, image };
  }));
  const latestImage = reviewImages[reviewImages.length - 1];

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_submissions
       SET review_id = ?, review_object_key = ?, review_access_token = ?,
           review_content_type = ?, review_byte_size = ?, reviewed_at = ?
       WHERE id = ?`
    ).bind(
      latestImage.reviewId,
      latestImage.objectKey,
      latestImage.accessToken,
      latestImage.image.type,
      latestImage.image.size,
      reviewedAt,
      submissionId
    ),
    ...(currentRound ? [] : [env.DB.prepare(
      `INSERT INTO submission_review_rounds
       (id, submission_id, sequence, note, photos_json, audio_json, review_object_key, review_access_token, review_content_type, submitted_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      roundId,
      submissionId,
      nextSequence,
      submission.note,
      JSON.stringify(photos),
      JSON.stringify(audio ? [audio] : []),
      latestImage.objectKey,
      latestImage.accessToken,
      latestImage.image.type,
      submission.submitted_at,
      reviewedAt
    )]),
    ...reviewImages.map((item, index) => env.DB.prepare(
      `INSERT INTO submission_review_images
       (id, review_round_id, sequence, object_key, access_token, content_type, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      item.reviewId,
      roundId,
      firstImageSequence + index,
      item.objectKey,
      item.accessToken,
      item.image.type,
      item.image.size,
      reviewedAt
    )),
    env.DB.prepare(
      `INSERT INTO notifications
       (id, recipient_user_id, submission_id, type, title, content, created_at)
       VALUES (?, ?, ?, 'review_completed', '作业批改完成', ?, ?)`
    ).bind(
      randomId("notification"),
      recipient.child_user_id,
      submissionId,
      `你的「${submission.task_title}」已完成 ${reviewImages.length} 张图片批改，快去看看吧！`,
      reviewedAt
    )
  ]);

  const updated = await getSubmissionRow(env, submissionId);
  return updated ? submissionDto(env, updated) : null;
}

export async function submitAudioReview(env: Env, user: AuthUser, submissionId: string, feedbackValue: string) {
  if (user.role !== "parent" && user.role !== "admin") {
    throw new Error("仅家长或管理员可以评价录音。");
  }

  const submission = await getSubmissionRow(env, submissionId);
  if (!submission) return null;
  if (submission.status !== "submitted") {
    throw new Error("小朋友尚未提交作业，暂不能评价录音。");
  }
  if (submission.finalized_at) {
    throw new Error("任务已完成，不能修改录音评价。");
  }
  if (user.role !== "admin" && !(await listChildren(env, user)).some((child) => child.id === submission.child_id)) {
    return null;
  }
  const audio = await getSubmissionAudio(env, submissionId);
  if (!audio) {
    throw new Error("当前提交没有录音，无法评价。");
  }

  const feedback = feedbackValue.trim();
  if (!feedback) throw new Error("请填写录音评价。");
  if (feedback.length > 500) throw new Error("录音评价不能超过 500 个字。");

  const recipient = await env.DB.prepare(
    "SELECT child_user_id FROM children WHERE id = ? LIMIT 1"
  ).bind(submission.child_id).first<{ child_user_id: string | null }>();
  if (!recipient?.child_user_id) throw new Error("未找到儿童账号，无法发送通知。");

  const reviewedAt = localTimestamp();
  const photos = await getSubmissionPhotos(env, submissionId);
  const nextSequence = (await env.DB.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM submission_review_rounds WHERE submission_id = ?"
  ).bind(submissionId).first<{ sequence: number }>())?.sequence || 1;
  const roundId = randomId("round");
  const roundAccessToken = randomId("review-round");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE task_submissions SET audio_feedback = ?, reviewed_at = ? WHERE id = ?"
    ).bind(feedback, reviewedAt, submissionId),
    env.DB.prepare(
      `INSERT INTO submission_review_rounds
       (id, submission_id, sequence, note, review_feedback, photos_json, audio_json,
        review_object_key, review_access_token, review_content_type, submitted_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '', ?, ?)`
    ).bind(
      roundId,
      submissionId,
      nextSequence,
      submission.note,
      feedback,
      JSON.stringify(photos),
      JSON.stringify([audio]),
      roundAccessToken,
      submission.submitted_at,
      reviewedAt
    ),
    env.DB.prepare(
      `INSERT INTO notifications
       (id, recipient_user_id, submission_id, type, title, content, created_at)
       VALUES (?, ?, ?, 'review_completed', '录音评价已提交', ?, ?)`
    ).bind(
      randomId("notification"),
      recipient.child_user_id,
      submissionId,
      `你的「${submission.task_title}」录音已收到评价，快去看看吧！`,
      reviewedAt
    )
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
    childId?: string;
    status?: "draft" | "submitted";
    reviewStatus?: "pending" | "reviewed" | "completed";
    page: number;
    pageSize: number;
  }
) {
  const accessibleChildIds = user.role === "child"
    ? [await childIdForUser(env, user)].filter((childId): childId is string => Boolean(childId))
    : (await listChildren(env, user)).map((child) => child.id);
  const childIds = options.childId
    ? accessibleChildIds.filter((childId) => childId === options.childId)
    : accessibleChildIds;

  if (!childIds.length) return { submissions: [], total: 0 };

  const childPlaceholders = childIds.map(() => "?").join(", ");
  // Timestamps are persisted as local UTC+8 wall-clock strings, so filtering
  // by date must use the stored value directly.
  const submittedDate = "DATE(task_submissions.submitted_at)";
  const conditions = [
    `task_submissions.child_id IN (${childPlaceholders})`,
    "task_submissions.status = ?"
  ];
  const values: Array<string | number> = [...childIds, options.status || "submitted"];

  if (options.date) {
    conditions.push(`${submittedDate} = ?`);
    values.push(options.date);
  }

  if (options.dateFrom && options.dateTo) {
    conditions.push(`${submittedDate} BETWEEN ? AND ?`);
    values.push(options.dateFrom, options.dateTo);
  }

  if (options.keyword) {
    conditions.push("LOWER(tasks.title) LIKE ?");
    values.push(`%${options.keyword.trim().toLowerCase()}%`);
  }

  if (options.reviewStatus === "completed") {
    conditions.push("task_submissions.finalized_at IS NOT NULL");
  } else if (options.reviewStatus === "reviewed") {
    conditions.push("task_submissions.reviewed_at IS NOT NULL AND task_submissions.finalized_at IS NULL");
  } else if (options.reviewStatus === "pending") {
    conditions.push("task_submissions.reviewed_at IS NULL AND task_submissions.finalized_at IS NULL");
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
      tasks.schedule_time AS schedule_time,
      children.name AS child_name
     FROM task_submissions
     INNER JOIN tasks
      ON tasks.id = task_submissions.task_id
     INNER JOIN children
      ON children.id = task_submissions.child_id
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

export async function deleteSubmission(env: Env, user: AuthUser, submissionId: string) {
  if (user.role === "child") {
    throw new Error("仅家长或管理员可以删除提交。");
  }

  const submission = await getSubmissionRowForDeletion(env, submissionId);
  if (!submission) return false;
  if (user.role !== "admin") {
    const children = await listChildren(env, user);
    if (!children.some((child) => child.id === submission.child_id)) return false;
  }

  const photos = await getSubmissionPhotos(env, submissionId);
  const audio = await getSubmissionAudio(env, submissionId);
  const reviewRounds = await env.DB.prepare(
    "SELECT * FROM submission_review_rounds WHERE submission_id = ?"
  ).bind(submissionId).all<ReviewRoundRow>();
  const reviewImages = await env.DB.prepare(
    `SELECT submission_review_images.*
     FROM submission_review_images
     INNER JOIN submission_review_rounds
       ON submission_review_rounds.id = submission_review_images.review_round_id
     WHERE submission_review_rounds.submission_id = ?`
  ).bind(submissionId).all<ReviewRoundImageRow>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notifications WHERE submission_id = ?").bind(submissionId),
    env.DB.prepare("DELETE FROM task_submission_photos WHERE submission_id = ?").bind(submissionId),
    env.DB.prepare("DELETE FROM task_submission_audios WHERE submission_id = ?").bind(submissionId),
    env.DB.prepare(
      `DELETE FROM submission_review_images
       WHERE review_round_id IN (
         SELECT id FROM submission_review_rounds WHERE submission_id = ?
       )`
    ).bind(submissionId),
    env.DB.prepare("DELETE FROM submission_review_rounds WHERE submission_id = ?").bind(submissionId),
    env.DB.prepare("DELETE FROM task_submissions WHERE id = ?").bind(submissionId),
    env.DB.prepare("DELETE FROM task_records WHERE task_id = ? AND date = ?").bind(submission.task_id, submission.task_date)
  ]);

  await Promise.all([
    ...photos.map((photo) => env.SUBMISSION_FILES.delete(photo.object_key)),
    ...(audio ? [env.SUBMISSION_FILES.delete(audio.object_key)] : []),
    ...reviewRounds.results.flatMap((round) => {
      try {
        return (JSON.parse(round.photos_json) as SubmissionPhotoRow[]).map((photo) => env.SUBMISSION_FILES.delete(photo.object_key));
      } catch {
        return [];
      }
    }),
    ...reviewRounds.results.flatMap((round) => {
      try {
        return (JSON.parse(round.audio_json || "[]") as SubmissionAudioRow[]).map((item) => env.SUBMISSION_FILES.delete(item.object_key));
      } catch {
        return [];
      }
    }),
    ...reviewRounds.results.map((round) => env.SUBMISSION_FILES.delete(round.review_object_key)),
    ...reviewImages.results.map((image) => env.SUBMISSION_FILES.delete(image.object_key)),
    ...(submission.review_object_key && !reviewRounds.results.some((round) => round.review_object_key === submission.review_object_key)
      ? [env.SUBMISSION_FILES.delete(submission.review_object_key)]
      : [])
  ]);
  return true;
}

export async function updateSubmissionNote(env: Env, user: AuthUser, submissionId: string, noteValue: string) {
  const childId = await childIdForSubmissionUser(env, user);
  const submission = await getSubmissionRow(env, submissionId);
  if (!submission || submission.child_id !== childId) return null;
  if (submission.finalized_at) throw new Error("任务已完成，备注不可编辑。");

  const note = noteValue.trim();
  if (note.length > 500) throw new Error("提交备注不能超过 500 个字。");
  await env.DB.prepare("UPDATE task_submissions SET note = ? WHERE id = ?").bind(note, submissionId).run();
  const updated = await getSubmissionRow(env, submissionId);
  return updated ? submissionDto(env, updated) : null;
}

export async function reopenSubmissionForResubmit(env: Env, user: AuthUser, submissionId: string) {
  const childId = await childIdForSubmissionUser(env, user);
  const submission = await getSubmissionRow(env, submissionId);
  if (!submission || submission.child_id !== childId || submission.status !== "submitted" || !submission.reviewed_at) return null;
  if (!submission.require_photo_upload) {
    throw new Error("该任务已改为无需提交附件，不能重新提交。");
  }

  // 兼容轮次表上线前的旧提交：儿童第一次重新提交时，先固化旧的原图、批改图与备注。
  // 后续批改由 submitReview 自动按 MAX(sequence) + 1 追加新的轮次。
  const existingRound = await env.DB.prepare(
    "SELECT id FROM submission_review_rounds WHERE submission_id = ? LIMIT 1"
  ).bind(submissionId).first<{ id: string }>();
  const photos = await getSubmissionPhotos(env, submissionId);
  const audio = await getSubmissionAudio(env, submissionId);
  const legacyRoundStatement = !existingRound && (Boolean(submission.review_id && submission.review_object_key
    && submission.review_access_token && submission.review_content_type) || Boolean(submission.audio_feedback))
    ? env.DB.prepare(
      `INSERT INTO submission_review_rounds
       (id, submission_id, sequence, note, review_feedback, photos_json, audio_json,
        review_object_key, review_access_token, review_content_type, reviewed_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      randomId("round"),
      submissionId,
      submission.note,
      submission.audio_feedback,
      JSON.stringify(photos),
      JSON.stringify(audio ? [audio] : []),
      submission.review_object_key || "",
      submission.review_access_token || randomId("review-round"),
      submission.review_content_type || "",
      submission.reviewed_at
    )
    : null;

  await env.DB.batch([
    ...(legacyRoundStatement ? [legacyRoundStatement] : []),
    env.DB.prepare("DELETE FROM notifications WHERE submission_id = ?").bind(submissionId),
    env.DB.prepare("DELETE FROM task_submission_photos WHERE submission_id = ?").bind(submissionId),
    env.DB.prepare("DELETE FROM task_submission_audios WHERE submission_id = ?").bind(submissionId),
    env.DB.prepare(
      `UPDATE task_submissions
       SET status = 'draft', note = '', submitted_at = NULL,
           review_id = NULL, review_object_key = NULL, review_access_token = NULL,
           review_content_type = NULL, review_byte_size = NULL, reviewed_at = NULL, finalized_at = NULL,
           audio_feedback = ''
       WHERE id = ?`
    ).bind(submissionId)
  ]);
  const updated = await getSubmissionRow(env, submissionId);
  return updated ? submissionDto(env, updated) : null;
}

export async function finalizeSubmissionReview(env: Env, user: AuthUser, submissionId: string) {
  if (user.role !== "parent" && user.role !== "admin") return null;
  const submission = await getSubmissionRow(env, submissionId);
  if (!submission) return null;
  if (user.role !== "admin" && !(await listChildren(env, user)).some((child) => child.id === submission.child_id)) return null;
  if (submission.status !== "submitted") {
    throw new Error("小朋友尚未提交附件，暂不能关闭任务。");
  }
  const photoCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM task_submission_photos WHERE submission_id = ?"
  ).bind(submissionId).first<{ count: number }>();
  const audio = await getSubmissionAudio(env, submissionId);
  if (!photoCount?.count && !audio) {
    throw new Error("小朋友尚未提交附件，暂不能关闭任务。");
  }
  const closedAt = localTimestamp();
  const recipient = await env.DB.prepare(
    "SELECT child_user_id FROM children WHERE id = ? LIMIT 1"
  )
    .bind(submission.child_id)
    .first<{ child_user_id: string | null }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE task_submissions SET finalized_at = ? WHERE id = ?").bind(closedAt, submissionId),
    env.DB.prepare(
      `INSERT INTO task_records (id, task_id, date, status, completed_at)
       VALUES (?, ?, ?, 'completed', ?)
       ON CONFLICT(task_id, date)
       DO UPDATE SET status = 'completed', completed_at = excluded.completed_at`
    ).bind(randomId("record"), submission.task_id, submission.task_date, closedAt),
    ...(recipient?.child_user_id ? [env.DB.prepare(
      `INSERT INTO notifications
       (id, recipient_user_id, submission_id, type, title, content, created_at)
       VALUES (?, ?, ?, 'task_completed', '任务已完成', ?, ?)`
    ).bind(
      randomId("notification"),
      recipient.child_user_id,
      submissionId,
      `你的「${submission.task_title}」已由家长确认完成。`,
      closedAt
    )] : [])
  ]);
  const updated = await getSubmissionRow(env, submissionId);
  return updated ? submissionDto(env, updated) : null;
}

export async function getTaskSubmissionForUser(env: Env, user: AuthUser, taskId: string, taskDate: string) {
  const row = await env.DB.prepare(
    `SELECT task_submissions.*, tasks.title AS task_title, tasks.schedule_time AS schedule_time,
      tasks.require_photo_upload AS require_photo_upload
     FROM task_submissions INNER JOIN tasks ON tasks.id = task_submissions.task_id
     WHERE task_submissions.task_id = ? AND task_submissions.task_date = ? LIMIT 1`
  ).bind(taskId, taskDate).first<SubmissionRow>();
  if (!row) return null;
  if (user.role === "child" && await childIdForUser(env, user) !== row.child_id) return null;
  if (user.role === "parent" && !(await listChildren(env, user)).some((child) => child.id === row.child_id)) return null;
  return submissionDto(env, row);
}

export async function listNotifications(env: Env, user: AuthUser) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM notifications
     WHERE recipient_user_id = ?
     ORDER BY created_at DESC
     LIMIT 30`
  )
    .bind(user.id)
    .all<NotificationRow>();

  return result.results.map<NotificationDto>((row) => ({
    id: row.id,
    submissionId: row.submission_id,
    type: row.type,
    title: row.title,
    content: row.content,
    readAt: row.read_at,
    createdAt: row.created_at
  }));
}

export async function markNotificationRead(env: Env, user: AuthUser, notificationId: string) {
  const result = await env.DB.prepare(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, ?)
     WHERE id = ? AND recipient_user_id = ?`
  )
    .bind(localTimestamp(), notificationId, user.id)
    .run();
  return result.meta.changes > 0;
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

export async function getSubmissionAudioObject(
  env: Env,
  audioId: string,
  accessToken: string,
  rangeHeaders?: Headers
) {
  const audio = await env.DB.prepare(
    `SELECT * FROM task_submission_audios
     WHERE id = ? AND access_token = ?
     LIMIT 1`
  ).bind(audioId, accessToken).first<SubmissionAudioRow>();
  if (!audio) return null;
  const object = await env.SUBMISSION_FILES.get(
    audio.object_key,
    rangeHeaders ? { range: rangeHeaders } : undefined
  );
  return object ? { object, audio } : null;
}

export async function getReviewImageObject(env: Env, reviewId: string, accessToken: string) {
  const submission = await env.DB.prepare(
    `SELECT review_object_key, review_content_type
     FROM task_submissions
     WHERE review_id = ? AND review_access_token = ?
     LIMIT 1`
  )
    .bind(reviewId, accessToken)
    .first<{ review_object_key: string | null; review_content_type: string | null }>();

  if (!submission?.review_object_key) {
    return null;
  }
  const object = await env.SUBMISSION_FILES.get(submission.review_object_key);
  return object ? { object, contentType: submission.review_content_type || "image/png" } : null;
}

async function getReviewRound(env: Env, roundId: string, accessToken: string) {
  return env.DB.prepare(
    `SELECT * FROM submission_review_rounds
     WHERE id = ? AND review_access_token = ?
     LIMIT 1`
  ).bind(roundId, accessToken).first<ReviewRoundRow>();
}

export async function getReviewRoundImageObject(env: Env, roundId: string, accessToken: string) {
  const round = await getReviewRound(env, roundId, accessToken);
  if (!round?.review_object_key) return null;
  const object = await env.SUBMISSION_FILES.get(round.review_object_key);
  return object ? { object, contentType: round.review_content_type || "image/png" } : null;
}

export async function getReviewRoundResultImageObject(env: Env, imageId: string, accessToken: string) {
  const image = await env.DB.prepare(
    `SELECT * FROM submission_review_images
     WHERE id = ? AND access_token = ?
     LIMIT 1`
  ).bind(imageId, accessToken).first<ReviewRoundImageRow>();
  if (!image) return null;
  const object = await env.SUBMISSION_FILES.get(image.object_key);
  return object ? { object, contentType: image.content_type || "image/png" } : null;
}

export async function getReviewRoundPhotoObject(env: Env, roundId: string, photoIndex: number, accessToken: string) {
  const round = await getReviewRound(env, roundId, accessToken);
  if (!round) return null;
  const photo = JSON.parse(round.photos_json) as SubmissionPhotoRow[];
  const selected = photo[photoIndex];
  if (!selected) return null;
  const object = await env.SUBMISSION_FILES.get(selected.object_key);
  return object ? { object, contentType: selected.content_type || "image/jpeg" } : null;
}

export async function getReviewRoundAudioObject(
  env: Env,
  roundId: string,
  audioIndex: number,
  accessToken: string,
  rangeHeaders?: Headers
) {
  const round = await getReviewRound(env, roundId, accessToken);
  if (!round) return null;
  let audios: SubmissionAudioRow[];
  try {
    audios = JSON.parse(round.audio_json || "[]") as SubmissionAudioRow[];
  } catch {
    return null;
  }
  const selected = audios[audioIndex];
  if (!selected) return null;
  const object = await env.SUBMISSION_FILES.get(
    selected.object_key,
    rangeHeaders ? { range: rangeHeaders } : undefined
  );
  return object ? { object, contentType: selected.content_type || "audio/mpeg" } : null;
}
