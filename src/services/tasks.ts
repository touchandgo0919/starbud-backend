import { localTimestamp, randomId } from "../utils";
import type { AuthUser, CreateTaskInput, Env, RepairTaskStatusInput, TaskDto, TaskRow } from "../types";
import { childIdForUser } from "./children";
import { listChildren } from "./children";

const repeatTypes = new Set(["once", "daily", "weekdays", "weekly"]);
const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

function dateParts(env: Env, date = new Date()) {
  const configuredTimeZone = env.APP_TIME_ZONE || "Asia/Shanghai";
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: configuredTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    });
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdayNumbers[parts.weekday] ?? date.getUTCDay()
  };
}

function storedDateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    return null;
  }
  return { key: `${match[1]}-${match[2]}-${match[3]}`, weekday: date.getDay() };
}

function shouldRunOnDate(
  env: Env,
  row: Pick<TaskRow, "repeat_type" | "created_at" | "start_date">,
  date = new Date()
) {
  const today = dateParts(env, date);
  const start = storedDateParts(row.start_date || row.created_at);
  if (!start) return false;

  if (today.key < start.key) {
    return false;
  }

  if (row.repeat_type === "daily") {
    return true;
  }

  if (row.repeat_type === "weekdays") {
    return today.weekday >= 1 && today.weekday <= 5;
  }

  return row.repeat_type === "weekly"
    ? start.weekday === today.weekday
    : start.key === today.key;
}

export function todayKey(env: Env, date = new Date()) {
  return dateParts(env, date).key;
}

function toTaskDto(row: TaskRow, occurrenceDate = row.record_date): TaskDto {
  // A re-submission always starts a new review cycle. Ignore any legacy review
  // or closure timestamp that predates the current submission.
  const hasCurrentReview = Boolean(
    row.reviewed_at && (!row.submitted_at || row.reviewed_at >= row.submitted_at)
  );
  const hasCurrentFinalization = Boolean(
    row.finalized_at && (!row.submitted_at || row.finalized_at >= row.submitted_at)
  );
  const awaitingParentClose = row.submission_status === "submitted" && !hasCurrentFinalization;
  const requiresPhotoUpload = Boolean(row.require_photo_upload);
  const taskStatus = !awaitingParentClose && row.record_status === "completed" ? "completed" : "pending";
  const reviewStatus = !requiresPhotoUpload
    ? (taskStatus === "completed" ? "completed" : "not_required")
    : hasCurrentFinalization
      ? "completed"
      : hasCurrentReview
        ? "needs_revision"
        : row.submission_status === "submitted"
          ? "pending_review"
          : row.submission_status === "draft" && (row.submission_photo_count || 0) > 0
            ? "submitting"
            : "pending_submission";
  return {
    id: row.id,
    childId: row.child_id,
    title: row.title,
    scheduleTime: row.schedule_time,
    repeatType: row.repeat_type,
    voiceEnabled: Boolean(row.voice_enable),
    voiceContent: row.voice_content?.trim() || row.title,
    voiceReminderCount: row.voice_reminder_count,
    claimReminderEnabled: Boolean(row.claim_reminder_enabled),
    requiresPhotoUpload,
    status: taskStatus,
    occurrenceDate,
    completedAt: awaitingParentClose ? null : row.completed_at,
    claimedAt: row.claimed_at || null,
    submissionId: row.submission_id || null,
    submissionStatus: row.submission_status === "draft" || row.submission_status === "submitted"
      ? row.submission_status
      : null,
    reviewedAt: hasCurrentReview ? row.reviewed_at : null,
    // 已完成后再次补交照片时，仍保留历史完成时间供统计使用；
    // 本轮是否需要批改继续由 hasCurrentFinalization / reviewStatus 判断。
    finalizedAt: row.finalized_at || null,
    needsRevision: hasCurrentReview && !hasCurrentFinalization,
    reviewStatus,
    submissionPhotoCount: row.submission_photo_count || 0,
    startDate: row.start_date || row.created_at.slice(0, 10),
    createdAt: row.created_at
  };
}

function withChildNames(tasks: TaskDto[], children: Array<{ id: string; name: string }>) {
  const names = new Map(children.map((child) => [child.id, child.name]));
  return tasks.map((task) => ({ ...task, childName: names.get(task.childId) || "" }));
}

export async function createTask(env: Env, input: CreateTaskInput) {
  const values = validateTaskInput(env, input);
  const id = randomId("task");
  const childId = input.childId;

  if (!childId) {
    throw new Error("Task target is required.");
  }

  await env.DB.prepare(
    `INSERT INTO tasks
      (id, child_id, title, schedule_time, repeat_type, voice_enable, voice_content, voice_reminder_count, claim_reminder_enabled, require_photo_upload, start_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      childId,
      values.title,
      values.scheduleTime,
      values.repeatType,
      values.voiceEnabled ? 1 : 0,
      values.voiceContent,
      values.voiceReminderCount,
      values.claimReminderEnabled ? 1 : 0,
      values.requiresPhotoUpload ? 1 : 0,
      values.startDate,
      localTimestamp()
    )
    .run();

  return getTaskById(env, id);
}

function validateTaskInput(env: Env, input: CreateTaskInput, fallbackStartDate = todayKey(env)) {
  const title = input.title?.trim();
  const scheduleTime = input.scheduleTime?.trim();
  const requestedVoiceContent = input.voiceContent?.trim();
  const voiceReminderCount = input.voiceReminderCount ?? 1;

  if (!title) {
    throw new Error("Task title is required.");
  }

  if (title.length > 40) {
    throw new Error("Task title cannot exceed 40 characters.");
  }

  const voiceContent = requestedVoiceContent || title;

  if (!scheduleTime || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
    throw new Error("scheduleTime must use HH:mm format.");
  }

  if (!input.repeatType || !repeatTypes.has(input.repeatType)) {
    throw new Error("Invalid repeat type.");
  }

  const startDate = input.startDate?.trim() || fallbackStartDate;
  if (!storedDateParts(startDate) || startDate.length !== 10) {
    throw new Error("startDate must use YYYY-MM-DD format.");
  }

  if (voiceContent.length > 120) {
    throw new Error("Voice reminder content cannot exceed 120 characters.");
  }

  if (!Number.isInteger(voiceReminderCount) || voiceReminderCount < 1 || voiceReminderCount > 3) {
    throw new Error("Voice reminder count must be between 1 and 3.");
  }

  return {
    title,
    scheduleTime,
    repeatType: input.repeatType,
    voiceEnabled: input.voiceEnabled !== false,
    voiceContent,
    voiceReminderCount,
    claimReminderEnabled: input.voiceEnabled !== false && input.claimReminderEnabled === true,
    requiresPhotoUpload: input.requiresPhotoUpload !== false,
    startDate
  };
}

export async function updateTaskForUser(
  env: Env,
  user: AuthUser,
  taskId: string,
  input: CreateTaskInput
) {
  if (user.role !== "parent" && user.role !== "admin") {
    return null;
  }

  const task = await getTaskById(env, taskId);
  if (!task || (user.role !== "admin" && !(await canAccessChild(env, user, task.childId)))) {
    return null;
  }

  const values = validateTaskInput(env, input, task.startDate);
  await env.DB.prepare(
    `UPDATE tasks
     SET title = ?,
      schedule_time = ?,
      repeat_type = ?,
      voice_enable = ?,
      voice_content = ?,
      voice_reminder_count = ?,
      claim_reminder_enabled = ?,
      require_photo_upload = ?,
      start_date = ?
     WHERE id = ?
      AND active = 1`
  )
    .bind(
      values.title,
      values.scheduleTime,
      values.repeatType,
      values.voiceEnabled ? 1 : 0,
      values.voiceContent,
      values.voiceReminderCount,
      values.claimReminderEnabled ? 1 : 0,
      values.requiresPhotoUpload ? 1 : 0,
      values.startDate,
      taskId
    )
    .run();

  return getTaskById(env, taskId);
}

export async function createTaskForUser(env: Env, user: AuthUser, input: CreateTaskInput) {
  if (user.role === "child") {
    throw new Error("仅家长或管理员可以创建任务。");
  }

  const childId = await resolveTaskChildId(env, user, input.childId);

  if (!childId) {
    throw new Error("Task target is required.");
  }

  return createTask(env, {
    ...input,
    childId
  });
}

export async function getTodayTasks(env: Env, childId?: string) {
  if (!childId) {
    return [];
  }

  const date = todayKey(env);

  const result = await env.DB.prepare(
    `SELECT
      tasks.*,
      task_records.status AS record_status,
      task_records.date AS record_date,
      task_records.completed_at AS completed_at,
      task_claims.claimed_at AS claimed_at,
      task_submissions.id AS submission_id,
      task_submissions.status AS submission_status,
      task_submissions.submitted_at AS submitted_at,
      task_submissions.reviewed_at AS reviewed_at,
      task_submissions.finalized_at AS finalized_at,
      (
        SELECT COUNT(*)
        FROM task_submission_photos
        WHERE task_submission_photos.submission_id = task_submissions.id
      ) AS submission_photo_count
     FROM tasks
     LEFT JOIN task_records
      ON task_records.task_id = tasks.id
      AND task_records.date = ?
     LEFT JOIN task_claims
      ON task_claims.task_id = tasks.id
      AND task_claims.child_id = tasks.child_id
      AND task_claims.task_date = ?
     LEFT JOIN task_submissions
      ON task_submissions.task_id = tasks.id
      AND task_submissions.child_id = tasks.child_id
      AND task_submissions.task_date = ?
     WHERE tasks.active = 1
      AND tasks.child_id = ?
     ORDER BY tasks.schedule_time ASC`
  )
    .bind(date, date, date, childId)
    .all<TaskRow>();

  return result.results
    .filter((row) => shouldRunOnDate(env, row))
    .map((row) => toTaskDto(row, date));
}

export async function getTodayTasksForUser(env: Env, user: AuthUser, requestedChildId?: string) {
  if (user.role !== "child") {
    const children = await listChildren(env, user);
    if (!requestedChildId) {
      const tasks = await Promise.all(children.map((child) => getTodayTasks(env, child.id)));
      return withChildNames(tasks.flat(), children).sort((left, right) => left.scheduleTime.localeCompare(right.scheduleTime));
    }

    const child = children.find((item) => item.id === requestedChildId);
    return child ? withChildNames(await getTodayTasks(env, child.id), [child]) : [];
  }

  const childId = await resolveTaskChildId(env, user, requestedChildId);

  if (!childId) {
    return [];
  }

  return getTodayTasks(env, childId);
}

export async function listTasksForUser(
  env: Env,
  user: AuthUser,
  filters: {
    childId?: string;
    status?: string;
    keyword?: string;
    repeatType?: string;
    date?: string;
    dateFrom?: string;
    dateTo?: string;
  }
) {
  const children = await listChildren(env, user);
  const selectedChildren = filters.childId
    ? children.filter((child) => child.id === filters.childId)
    : children;
  const requestedRange = resolveRequestedRange(filters);

  if (requestedRange) {
    const occurrenceGroups = await Promise.all(
      selectedChildren.map((child) =>
        getTaskOccurrences(env, child.id, requestedRange.from, requestedRange.to)
      )
    );
    return filterAndSortTasks(withChildNames(occurrenceGroups.flat(), selectedChildren), filters);
  }

  const includePending = !filters.status || filters.status === "pending";
  const includeCompleted = !filters.status || filters.status === "completed";
  const pendingGroups = includePending
    ? await Promise.all(
        selectedChildren.map(async (child) =>
          (await getTodayTasks(env, child.id)).filter((task) => task.status === "pending")
        )
      )
    : [];
  const completedGroups = includeCompleted
    ? await Promise.all(selectedChildren.map((child) => getCompletedTasks(env, child.id)))
    : [];
  return filterAndSortTasks(withChildNames([...pendingGroups, ...completedGroups].flat(), selectedChildren), filters);
}

export async function listTaskDefinitionsForUser(env: Env, user: AuthUser) {
  const children = await listChildren(env, user);
  if (!children.length) return [];

  const date = todayKey(env);
  const childPlaceholders = children.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT
      tasks.*,
      task_records.status AS record_status,
      task_records.date AS record_date,
      task_records.completed_at AS completed_at,
      task_claims.claimed_at AS claimed_at,
      task_submissions.id AS submission_id,
      task_submissions.status AS submission_status,
      task_submissions.submitted_at AS submitted_at,
      task_submissions.reviewed_at AS reviewed_at,
      task_submissions.finalized_at AS finalized_at,
      (
        SELECT COUNT(*)
        FROM task_submission_photos
        WHERE task_submission_photos.submission_id = task_submissions.id
      ) AS submission_photo_count
     FROM tasks
     LEFT JOIN task_records
      ON task_records.task_id = tasks.id
      AND task_records.date = ?
     LEFT JOIN task_claims
      ON task_claims.task_id = tasks.id
      AND task_claims.child_id = tasks.child_id
      AND task_claims.task_date = ?
     LEFT JOIN task_submissions
      ON task_submissions.task_id = tasks.id
      AND task_submissions.child_id = tasks.child_id
      AND task_submissions.task_date = ?
     WHERE tasks.active = 1
      AND tasks.child_id IN (${childPlaceholders})
     ORDER BY tasks.created_at DESC, tasks.schedule_time ASC`
  )
    .bind(date, date, date, ...children.map((child) => child.id))
    .all<TaskRow>();

  return withChildNames(result.results.map((row) => toTaskDto(row, null)), children);
}

function filterAndSortTasks(
  tasks: TaskDto[],
  filters: { status?: string; keyword?: string; repeatType?: string }
) {
  const keyword = filters.keyword?.trim().toLocaleLowerCase() || "";

  return tasks
    .filter((task) => !filters.status || task.status === filters.status)
    .filter((task) => !filters.repeatType || task.repeatType === filters.repeatType)
    .filter((task) => !keyword || task.title.toLocaleLowerCase().includes(keyword))
    .sort((left, right) => {
      if (left.occurrenceDate !== right.occurrenceDate) {
        return (left.occurrenceDate || "").localeCompare(right.occurrenceDate || "");
      }
      if (left.status !== right.status) {
        return left.status === "pending" ? -1 : 1;
      }
      if (left.status === "completed") {
        return (right.completedAt || right.occurrenceDate || "")
          .localeCompare(left.completedAt || left.occurrenceDate || "");
      }
      return left.scheduleTime.localeCompare(right.scheduleTime);
    });
}

function resolveRequestedRange(filters: { date?: string; dateFrom?: string; dateTo?: string }) {
  if (filters.date) {
    const date = parseDateKey(filters.date);
    return date ? { from: filters.date, to: filters.date } : null;
  }

  if (!filters.dateFrom && !filters.dateTo) {
    return null;
  }

  const from = filters.dateFrom && parseDateKey(filters.dateFrom) ? filters.dateFrom : null;
  const to = filters.dateTo && parseDateKey(filters.dateTo) ? filters.dateTo : null;

  if (!from || !to || from > to) {
    return null;
  }

  const dates = dateKeysBetween(from, to);
  if (dates.length > 62) {
    return null;
  }

  return { from, to };
}

function parseDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ? null : date;
}

function dateKeysBetween(from: string, to: string) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  if (!start || !end) return [];

  const dates: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    dates.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`);
  }
  return dates;
}

async function getTaskOccurrences(env: Env, childId: string, from: string, to: string) {
  const [taskResult, recordResult, submissionResult, claimResult] = await Promise.all([
    env.DB.prepare(
      `SELECT
        tasks.*,
        NULL AS record_status,
        NULL AS record_date,
        NULL AS completed_at,
        NULL AS claimed_at,
        NULL AS submission_id,
        NULL AS submission_status,
        NULL AS reviewed_at,
        NULL AS finalized_at,
        NULL AS submission_photo_count
       FROM tasks
       WHERE tasks.active = 1
        AND tasks.child_id = ?`
    )
      .bind(childId)
      .all<TaskRow>(),
    env.DB.prepare(
      `SELECT task_records.task_id, task_records.date, task_records.status, task_records.completed_at
       FROM task_records
       INNER JOIN tasks ON tasks.id = task_records.task_id
       WHERE tasks.active = 1
        AND tasks.child_id = ?
        AND task_records.date BETWEEN ? AND ?`
      )
      .bind(childId, from, to)
      .all<{ task_id: string; date: string; status: string; completed_at: string | null }>(),
    env.DB.prepare(
      `SELECT
        task_submissions.id AS submission_id,
        task_submissions.task_id,
        task_submissions.task_date,
        task_submissions.status AS submission_status,
        task_submissions.reviewed_at AS reviewed_at,
        task_submissions.finalized_at AS finalized_at,
        (
          SELECT COUNT(*)
          FROM task_submission_photos
          WHERE task_submission_photos.submission_id = task_submissions.id
        ) AS submission_photo_count
       FROM task_submissions
       INNER JOIN tasks ON tasks.id = task_submissions.task_id
       WHERE tasks.active = 1
        AND tasks.child_id = ?
        AND task_submissions.task_date BETWEEN ? AND ?`
    )
      .bind(childId, from, to)
      .all<{
        submission_id: string;
        task_id: string;
        task_date: string;
        submission_status: "draft" | "submitted";
        reviewed_at: string | null;
        finalized_at: string | null;
        submission_photo_count: number;
      }>(),
    env.DB.prepare(
      `SELECT task_claims.task_id, task_claims.task_date, task_claims.claimed_at
       FROM task_claims
       INNER JOIN tasks ON tasks.id = task_claims.task_id
       WHERE tasks.active = 1
        AND tasks.child_id = ?
        AND task_claims.task_date BETWEEN ? AND ?`
    )
      .bind(childId, from, to)
      .all<{ task_id: string; task_date: string; claimed_at: string | null }>()
  ]);
  const records = new Map(
    recordResult.results.map((record) => [`${record.task_id}:${record.date}`, record])
  );
  const submissions = new Map(
    submissionResult.results.map((submission) => [
      `${submission.task_id}:${submission.task_date}`,
      submission
    ])
  );
  const claims = new Map(
    claimResult.results.map((claim) => [`${claim.task_id}:${claim.task_date}`, claim])
  );

  return dateKeysBetween(from, to).flatMap((dateKey) => {
    const occurrenceDate = parseDateKey(dateKey);
    if (!occurrenceDate) return [];

    return taskResult.results
      .filter((row) => shouldRunOnDate(env, row, occurrenceDate))
      .map((row) => {
        const record = records.get(`${row.id}:${dateKey}`);
        const submission = submissions.get(`${row.id}:${dateKey}`);
        const claim = claims.get(`${row.id}:${dateKey}`);
        return toTaskDto(
          {
            ...row,
            record_status: record?.status || null,
            record_date: dateKey,
            completed_at: record?.completed_at || null,
            claimed_at: claim?.claimed_at || null,
            submission_id: submission?.submission_id || null,
            submission_status: submission?.submission_status || null,
            reviewed_at: submission?.reviewed_at || null,
            finalized_at: submission?.finalized_at || null,
            submission_photo_count: submission?.submission_photo_count || null
          },
          dateKey
        );
      });
  });
}

async function getCompletedTasks(env: Env, childId: string) {
  const result = await env.DB.prepare(
    `SELECT
      tasks.*,
      task_records.status AS record_status,
      task_records.date AS record_date,
      task_records.completed_at AS completed_at,
      task_claims.claimed_at AS claimed_at,
      task_submissions.id AS submission_id,
      task_submissions.status AS submission_status,
      task_submissions.submitted_at AS submitted_at,
      task_submissions.reviewed_at AS reviewed_at,
      task_submissions.finalized_at AS finalized_at,
      (
        SELECT COUNT(*)
        FROM task_submission_photos
        WHERE task_submission_photos.submission_id = task_submissions.id
      ) AS submission_photo_count
     FROM task_records
     INNER JOIN tasks
      ON tasks.id = task_records.task_id
     LEFT JOIN task_claims
      ON task_claims.task_id = tasks.id
      AND task_claims.child_id = tasks.child_id
      AND task_claims.task_date = task_records.date
     LEFT JOIN task_submissions
      ON task_submissions.task_id = tasks.id
      AND task_submissions.child_id = tasks.child_id
      AND task_submissions.task_date = task_records.date
     WHERE tasks.active = 1
      AND tasks.child_id = ?
      AND task_records.status = 'completed'
      AND (task_submissions.id IS NULL OR task_submissions.finalized_at IS NOT NULL)
     ORDER BY task_records.date DESC, task_records.completed_at DESC`
  )
    .bind(childId)
    .all<TaskRow>();

  return result.results.map((row) => toTaskDto(row));
}

export async function completeTask(env: Env, taskId: string, taskDate = todayKey(env)) {
  const existing = await getTaskById(env, taskId, taskDate, true);

  if (!existing) {
    return null;
  }

  const completedAt = localTimestamp();

  await env.DB.prepare(
    `INSERT INTO task_records (id, task_id, date, status, completed_at)
     VALUES (?, ?, ?, 'completed', ?)
     ON CONFLICT(task_id, date)
     DO UPDATE SET status = 'completed', completed_at = excluded.completed_at`
  )
    .bind(randomId("record"), taskId, taskDate, completedAt)
    .run();

  return getTaskById(env, taskId, taskDate);
}

export async function completeTaskForUser(env: Env, user: AuthUser, taskId: string, taskDate?: string) {
  const date = taskDate || todayKey(env);
  const task = await getTaskById(env, taskId, date, true);

  if (!task) {
    return null;
  }

  if (user.role === "child" && (await childIdForUser(env, user)) !== task.childId) {
    return null;
  }

  if (user.role === "parent" && !(await canAccessChild(env, user, task.childId))) {
    return null;
  }

  if (!task.claimedAt) {
    throw new Error("请等待小朋友领取任务后再关闭。");
  }

  if (task.requiresPhotoUpload) {
    throw new Error("附件任务需由小朋友提交照片或录音后，在提交详情中关闭。");
  }

  return completeTask(env, taskId, date);
}

/** Parent-only recovery tool for correcting accidental claim/completion state. */
export async function repairTaskStatusForUser(
  env: Env,
  user: AuthUser,
  taskId: string,
  input: RepairTaskStatusInput
) {
  if (user.role !== "parent" && user.role !== "admin") return null;
  if (!input.status || !["unclaimed", "claimed", "completed"].includes(input.status)) {
    throw new Error("请选择有效的任务状态。");
  }

  const date = input.taskDate || todayKey(env);
  const task = await getTaskById(env, taskId, date, true);
  if (!task || (user.role !== "admin" && !(await canAccessChild(env, user, task.childId)))) return null;

  const submission = await env.DB.prepare(
    `SELECT task_submissions.id, task_submissions.status,
            tasks.title AS task_title, children.child_user_id
     FROM task_submissions
     INNER JOIN tasks ON tasks.id = task_submissions.task_id
     INNER JOIN children ON children.id = task_submissions.child_id
     WHERE task_submissions.task_id = ? AND task_submissions.child_id = ? AND task_submissions.task_date = ?
     LIMIT 1`
  ).bind(taskId, task.childId, date).first<{
    id: string;
    status: string;
    task_title: string;
    child_user_id: string | null;
  }>();

  if (input.status === "unclaimed") {
    if (submission) {
      throw new Error("已有作业提交，不能恢复为待领取；请先在提交管理中处理作业记录。");
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM task_records WHERE task_id = ? AND date = ?").bind(taskId, date),
      env.DB.prepare("DELETE FROM task_claims WHERE task_id = ? AND child_id = ? AND task_date = ?")
        .bind(taskId, task.childId, date)
    ]);
  } else if (input.status === "claimed") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM task_records WHERE task_id = ? AND date = ?").bind(taskId, date),
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_claims (id, task_id, child_id, task_date, claimed_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(randomId("claim"), taskId, task.childId, date, localTimestamp())
    ]);
  } else {
    const completedAt = localTimestamp();
    const statements = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_claims (id, task_id, child_id, task_date, claimed_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(randomId("claim"), taskId, task.childId, date, completedAt),
      env.DB.prepare(
        `INSERT INTO task_records (id, task_id, date, status, completed_at)
         VALUES (?, ?, ?, 'completed', ?)
         ON CONFLICT(task_id, date)
         DO UPDATE SET status = 'completed', completed_at = excluded.completed_at`
      ).bind(randomId("record"), taskId, date, completedAt)
    ];

    if (task.requiresPhotoUpload) {
      const photoCount = submission
        ? await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM task_submission_photos WHERE submission_id = ?"
        ).bind(submission.id).first<{ count: number }>()
        : null;
      const audio = submission
        ? await env.DB.prepare("SELECT id FROM task_submission_audios WHERE submission_id = ? LIMIT 1")
          .bind(submission.id).first<{ id: string }>()
        : null;
      if (submission?.status !== "submitted" || (!photoCount?.count && !audio)) {
        throw new Error("附件任务需至少提交一张照片或一段录音后才能直接完成。");
      }

      statements.push(
        env.DB.prepare("UPDATE task_submissions SET finalized_at = ? WHERE id = ?")
          .bind(completedAt, submission.id)
      );
      if (submission.child_user_id) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO notifications
             (id, recipient_user_id, submission_id, type, title, content, created_at)
             VALUES (?, ?, ?, 'task_completed', '任务已完成', ?, ?)`
          ).bind(
            randomId("notification"),
            submission.child_user_id,
            submission.id,
            `你的「${submission.task_title}」已由家长确认完成。`,
            completedAt
          )
        );
      }
    }

    await env.DB.batch(statements);
  }

  return getTaskById(env, taskId, date);
}

export async function remindTaskForUser(env: Env, user: AuthUser, taskId: string) {
  if (user.role === "child") {
    throw new Error("仅家长或管理员可以发起提醒。");
  }

  const task = await getTaskById(env, taskId);
  if (!task || !task.voiceEnabled) {
    return null;
  }

  if (user.role !== "admin") {
    const children = await listChildren(env, user);
    if (!children.some((child) => child.id === task.childId)) {
      return null;
    }
  }

  const child = await env.DB.prepare(
    "SELECT child_user_id FROM children WHERE id = ? LIMIT 1"
  )
    .bind(task.childId)
    .first<{ child_user_id: string | null }>();
  if (!child?.child_user_id) {
    return null;
  }

  await env.DB.prepare(
    `INSERT INTO notifications
     (id, recipient_user_id, type, title, content, created_at)
     VALUES (?, ?, 'voice_reminder', '星星芽AI助手 任务提醒', ?, ?)`
  )
    .bind(randomId("notification"), child.child_user_id, task.voiceContent, localTimestamp())
    .run();

  return task;
}

export async function recordFinalVoiceReminderForUser(
  env: Env,
  user: AuthUser,
  taskId: string,
  taskDate?: string
) {
  if (user.role !== "child") {
    throw new Error("仅儿童设备可以确认语音提醒已播放完成。");
  }

  const childId = await childIdForUser(env, user);
  const date = taskDate || todayKey(env);
  const task = await getTaskById(env, taskId, date, true);
  if (!task || task.childId !== childId || !task.claimReminderEnabled || task.claimedAt || task.status !== "pending") {
    return null;
  }

  await env.DB.prepare(
    `INSERT INTO task_claim_reminders (task_id, task_date, voice_completed_at, last_reminded_at, reminder_count)
     VALUES (?, ?, ?, NULL, 0)
     ON CONFLICT(task_id, task_date)
     DO UPDATE SET voice_completed_at = excluded.voice_completed_at, last_reminded_at = NULL, reminder_count = 0`
  ).bind(taskId, date, localTimestamp()).run();

  return task;
}

export async function sendDueClaimReminders(env: Env) {
  const now = localTimestamp();
  const result = await env.DB.prepare(
    `SELECT
      task_claim_reminders.task_id,
      task_claim_reminders.task_date,
      tasks.child_id,
      tasks.title,
      children.child_user_id
     FROM task_claim_reminders
     INNER JOIN tasks ON tasks.id = task_claim_reminders.task_id
     INNER JOIN children ON children.id = tasks.child_id
     LEFT JOIN task_claims
      ON task_claims.task_id = task_claim_reminders.task_id
      AND task_claims.child_id = tasks.child_id
      AND task_claims.task_date = task_claim_reminders.task_date
     LEFT JOIN task_records
      ON task_records.task_id = task_claim_reminders.task_id
      AND task_records.date = task_claim_reminders.task_date
     WHERE tasks.active = 1
      AND tasks.claim_reminder_enabled = 1
      AND children.child_user_id IS NOT NULL
      AND task_claims.claimed_at IS NULL
      AND COALESCE(task_records.status, 'pending') != 'completed'
      AND task_claim_reminders.reminder_count < 3
      AND datetime(task_claim_reminders.voice_completed_at, '+5 minutes') <= datetime(?)
      AND (
        task_claim_reminders.last_reminded_at IS NULL
        OR datetime(task_claim_reminders.last_reminded_at, '+5 minutes') <= datetime(?)
      )`
  ).bind(now, now).all<{ task_id: string; task_date: string; child_id: string; title: string; child_user_id: string }>();

  if (!result.results.length) return 0;

  await env.DB.batch(result.results.flatMap((task) => [
    env.DB.prepare(
      `INSERT INTO notifications
       (id, recipient_user_id, type, title, content, created_at)
       VALUES (?, ?, 'claim_reminder', '星星芽AI助手 领取提醒', ?, ?)`
    ).bind(randomId("notification"), task.child_user_id, `「${task.title}」还没有领取，请点击去领取。`, now),
    env.DB.prepare(
       `UPDATE task_claim_reminders
       SET last_reminded_at = ?, reminder_count = reminder_count + 1
       WHERE task_id = ? AND task_date = ? AND reminder_count < 3`
    ).bind(now, task.task_id, task.task_date)
  ]));

  return result.results.length;
}

export async function claimTaskForUser(env: Env, user: AuthUser, taskId: string, taskDate?: string) {
  if (user.role !== "child") {
    throw new Error("仅儿童账号可以领取任务。");
  }

  const childId = await childIdForUser(env, user);
  if (!childId) {
    throw new Error("当前儿童账号尚未关联家庭成员。");
  }

  const date = taskDate || todayKey(env);
  const task = await getTaskById(env, taskId, date, true);
  if (!task || task.childId !== childId) {
    return null;
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO task_claims (id, task_id, child_id, task_date, claimed_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(randomId("claim"), taskId, childId, date, localTimestamp())
    .run();

  if (!task.requiresPhotoUpload) {
    return completeTask(env, taskId, date);
  }

  return getTaskById(env, taskId, date);
}

export async function deleteTaskForUser(env: Env, user: AuthUser, taskId: string) {
  if (user.role !== "parent" && user.role !== "admin") {
    return false;
  }

  const task = await getTaskById(env, taskId);

  if (!task || (user.role !== "admin" && !(await canAccessChild(env, user, task.childId)))) {
    return false;
  }

  const result = await env.DB.prepare(
    `UPDATE tasks
     SET active = 0
     WHERE id = ?
      AND active = 1`
  )
    .bind(taskId)
    .run();

  return result.meta.changes > 0;
}

export async function getTaskById(env: Env, taskId: string, date = todayKey(env), requireOccurrence = false) {
  if (!parseDateKey(date)) return null;
  const row = await env.DB.prepare(
    `SELECT
      tasks.*,
      task_records.status AS record_status,
      task_records.date AS record_date,
      task_records.completed_at AS completed_at,
      task_claims.claimed_at AS claimed_at,
      task_submissions.id AS submission_id,
      task_submissions.status AS submission_status,
      task_submissions.submitted_at AS submitted_at,
      task_submissions.reviewed_at AS reviewed_at,
      task_submissions.finalized_at AS finalized_at,
      (
        SELECT COUNT(*)
        FROM task_submission_photos
        WHERE task_submission_photos.submission_id = task_submissions.id
      ) AS submission_photo_count
     FROM tasks
     LEFT JOIN task_records
      ON task_records.task_id = tasks.id
      AND task_records.date = ?
     LEFT JOIN task_claims
      ON task_claims.task_id = tasks.id
      AND task_claims.child_id = tasks.child_id
      AND task_claims.task_date = ?
     LEFT JOIN task_submissions
      ON task_submissions.task_id = tasks.id
      AND task_submissions.child_id = tasks.child_id
      AND task_submissions.task_date = ?
     WHERE tasks.id = ?
      AND tasks.active = 1
     LIMIT 1`
  )
    .bind(date, date, date, taskId)
    .first<TaskRow>();

  if (!row) return null;
  if (requireOccurrence && !shouldRunOnDate(env, row, parseDateKey(date) || undefined)) return null;
  return toTaskDto(row, date);
}

export async function getTaskForUser(env: Env, user: AuthUser, taskId: string, taskDate?: string) {
  const task = await getTaskById(env, taskId, taskDate || todayKey(env));
  if (!task || user.role === "admin") return task;

  if (user.role === "child") {
    return (await childIdForUser(env, user)) === task.childId ? task : null;
  }

  return (await canAccessChild(env, user, task.childId)) ? task : null;
}

async function resolveTaskChildId(env: Env, user: AuthUser, requestedChildId?: string) {
  if (user.role === "child") {
    return childIdForUser(env, user);
  }

  if (user.role === "admin") {
    if (requestedChildId) {
      const child = await env.DB.prepare("SELECT id FROM children WHERE id = ? LIMIT 1")
        .bind(requestedChildId)
        .first<{ id: string }>();
      return child?.id || null;
    }

    const child = await env.DB.prepare("SELECT id FROM children ORDER BY name ASC LIMIT 1")
      .first<{ id: string }>();
    return child?.id || null;
  }

  if (requestedChildId) {
    return (await canAccessChild(env, user, requestedChildId)) ? requestedChildId : null;
  }

  const child = await env.DB.prepare(
    `SELECT children.id
     FROM children
     INNER JOIN family_members child_member
      ON child_member.user_id = children.child_user_id
     INNER JOIN family_members parent_member
      ON parent_member.family_id = child_member.family_id
     WHERE parent_member.user_id = ?
     ORDER BY children.name ASC
     LIMIT 1`
  )
    .bind(user.id)
    .first<{ id: string }>();

  return child?.id || null;
}

export async function canAccessChild(env: Env, user: AuthUser, childId: string) {
  const child = await env.DB.prepare(
    `SELECT children.id
     FROM children
     INNER JOIN family_members child_member
      ON child_member.user_id = children.child_user_id
     INNER JOIN family_members parent_member
      ON parent_member.family_id = child_member.family_id
     WHERE children.id = ? AND parent_member.user_id = ?
     LIMIT 1`
  )
    .bind(childId, user.id)
    .first<{ id: string }>();

  return Boolean(child);
}
