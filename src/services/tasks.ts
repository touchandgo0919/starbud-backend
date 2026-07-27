import { randomId } from "../utils";
import type { AuthUser, CreateTaskInput, Env, TaskDto, TaskRow } from "../types";
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

function parseCreatedAt(value: string) {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  return new Date(normalized);
}

function shouldRunOnDate(
  env: Env,
  row: Pick<TaskRow, "repeat_type" | "created_at">,
  date = new Date()
) {
  const today = dateParts(env, date);
  const created = dateParts(env, parseCreatedAt(row.created_at));

  if (today.key < created.key) {
    return false;
  }

  if (row.repeat_type === "daily") {
    return true;
  }

  if (row.repeat_type === "weekdays") {
    return today.weekday >= 1 && today.weekday <= 5;
  }

  return row.repeat_type === "weekly"
    ? created.weekday === today.weekday
    : created.key === today.key;
}

export function todayKey(env: Env, date = new Date()) {
  return dateParts(env, date).key;
}

function toTaskDto(row: TaskRow, occurrenceDate = row.record_date): TaskDto {
  return {
    id: row.id,
    childId: row.child_id,
    title: row.title,
    scheduleTime: row.schedule_time,
    repeatType: row.repeat_type,
    voiceEnabled: Boolean(row.voice_enable),
    voiceContent: row.voice_content?.trim() || row.title,
    voiceReminderCount: row.voice_reminder_count,
    status: row.record_status === "completed" ? "completed" : "pending",
    occurrenceDate,
    completedAt: row.completed_at,
    claimedAt: row.claimed_at || null,
    submissionId: row.submission_id || null,
    submissionStatus: row.submission_status === "draft" || row.submission_status === "submitted"
      ? row.submission_status
      : null,
    submissionPhotoCount: row.submission_photo_count || 0,
    createdAt: row.created_at
  };
}

export async function createTask(env: Env, input: CreateTaskInput) {
  const values = validateTaskInput(input);
  const id = randomId("task");
  const childId = input.childId;

  if (!childId) {
    throw new Error("Task target is required.");
  }

  await env.DB.prepare(
    `INSERT INTO tasks
      (id, child_id, title, schedule_time, repeat_type, voice_enable, voice_content, voice_reminder_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      childId,
      values.title,
      values.scheduleTime,
      values.repeatType,
      values.voiceEnabled ? 1 : 0,
      values.voiceContent,
      values.voiceReminderCount
    )
    .run();

  return getTaskById(env, id);
}

function validateTaskInput(input: CreateTaskInput) {
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
    voiceReminderCount
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

  const values = validateTaskInput(input);
  await env.DB.prepare(
    `UPDATE tasks
     SET title = ?,
      schedule_time = ?,
      repeat_type = ?,
      voice_enable = ?,
      voice_content = ?,
      voice_reminder_count = ?
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
  if (user.role !== "child" && !requestedChildId) {
    const children = await listChildren(env, user);
    const tasks = await Promise.all(children.map((child) => getTodayTasks(env, child.id)));
    return tasks.flat().sort((left, right) => left.scheduleTime.localeCompare(right.scheduleTime));
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
    return filterAndSortTasks(occurrenceGroups.flat(), filters);
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
  return filterAndSortTasks([...pendingGroups, ...completedGroups].flat(), filters);
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

  return result.results.map((row) => toTaskDto(row, null));
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

  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function dateKeysBetween(from: string, to: string) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  if (!start || !end) return [];

  const dates: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

async function getTaskOccurrences(env: Env, childId: string, from: string, to: string) {
  const [taskResult, recordResult, submissionResult] = await Promise.all([
    env.DB.prepare(
      `SELECT
        tasks.*,
        NULL AS record_status,
        NULL AS record_date,
        NULL AS completed_at,
        NULL AS claimed_at,
        NULL AS submission_id,
        NULL AS submission_status,
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
        submission_photo_count: number;
      }>()
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

  return dateKeysBetween(from, to).flatMap((dateKey) => {
    const occurrenceDate = parseDateKey(dateKey);
    if (!occurrenceDate) return [];

    return taskResult.results
      .filter((row) => shouldRunOnDate(env, row, occurrenceDate))
      .map((row) => {
        const record = records.get(`${row.id}:${dateKey}`);
        const submission = submissions.get(`${row.id}:${dateKey}`);
        return toTaskDto(
          {
            ...row,
            record_status: record?.status || null,
            record_date: dateKey,
            completed_at: record?.completed_at || null,
            submission_id: submission?.submission_id || null,
            submission_status: submission?.submission_status || null,
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
      NULL AS claimed_at,
      task_submissions.id AS submission_id,
      task_submissions.status AS submission_status,
      (
        SELECT COUNT(*)
        FROM task_submission_photos
        WHERE task_submission_photos.submission_id = task_submissions.id
      ) AS submission_photo_count
     FROM task_records
     INNER JOIN tasks
      ON tasks.id = task_records.task_id
     LEFT JOIN task_submissions
      ON task_submissions.task_id = tasks.id
      AND task_submissions.child_id = tasks.child_id
      AND task_submissions.task_date = task_records.date
     WHERE tasks.active = 1
      AND tasks.child_id = ?
      AND task_records.status = 'completed'
     ORDER BY task_records.date DESC, task_records.completed_at DESC`
  )
    .bind(childId)
    .all<TaskRow>();

  return result.results.map((row) => toTaskDto(row));
}

export async function completeTask(env: Env, taskId: string) {
  const existing = await getTaskById(env, taskId);

  if (
    !existing ||
    !shouldRunOnDate(env, {
      repeat_type: existing.repeatType,
      created_at: existing.createdAt
    })
  ) {
    return null;
  }

  const date = todayKey(env);
  const completedAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO task_records (id, task_id, date, status, completed_at)
     VALUES (?, ?, ?, 'completed', ?)
     ON CONFLICT(task_id, date)
     DO UPDATE SET status = 'completed', completed_at = excluded.completed_at`
  )
    .bind(randomId("record"), taskId, date, completedAt)
    .run();

  return getTaskById(env, taskId);
}

export async function completeTaskForUser(env: Env, user: AuthUser, taskId: string) {
  const task = await getTaskById(env, taskId);

  if (!task) {
    return null;
  }

  if (user.role === "child" && (await childIdForUser(env, user)) !== task.childId) {
    return null;
  }

  if (user.role === "parent" && !(await canAccessChild(env, user, task.childId))) {
    return null;
  }

  return completeTask(env, taskId);
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
     (id, recipient_user_id, type, title, content)
     VALUES (?, ?, 'voice_reminder', '星星芽AI助手 任务提醒', ?)`
  )
    .bind(randomId("notification"), child.child_user_id, task.voiceContent)
    .run();

  return task;
}

export async function claimTaskForUser(env: Env, user: AuthUser, taskId: string) {
  if (user.role !== "child") {
    throw new Error("仅儿童账号可以领取任务。");
  }

  const childId = await childIdForUser(env, user);
  if (!childId) {
    throw new Error("当前儿童账号尚未关联家庭成员。");
  }

  const task = (await getTodayTasks(env, childId)).find((item) => item.id === taskId);
  if (!task) {
    return null;
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO task_claims (id, task_id, child_id, task_date)
     VALUES (?, ?, ?, ?)`
  )
    .bind(randomId("claim"), taskId, childId, todayKey(env))
    .run();

  return getTaskById(env, taskId);
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

export async function getTaskById(env: Env, taskId: string) {
  const date = todayKey(env);
  const row = await env.DB.prepare(
    `SELECT
      tasks.*,
      task_records.status AS record_status,
      task_records.date AS record_date,
      task_records.completed_at AS completed_at,
      task_claims.claimed_at AS claimed_at,
      task_submissions.id AS submission_id,
      task_submissions.status AS submission_status,
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

  return row ? toTaskDto(row) : null;
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
