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

  if (row.repeat_type === "daily") {
    return true;
  }

  if (row.repeat_type === "weekdays") {
    return today.weekday >= 1 && today.weekday <= 5;
  }

  const created = dateParts(env, parseCreatedAt(row.created_at));
  return row.repeat_type === "weekly"
    ? created.weekday === today.weekday
    : created.key === today.key;
}

function todayKey(env: Env, date = new Date()) {
  return dateParts(env, date).key;
}

function toTaskDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    childId: row.child_id,
    title: row.title,
    scheduleTime: row.schedule_time,
    repeatType: row.repeat_type,
    voiceEnabled: Boolean(row.voice_enable),
    voiceContent: row.voice_content?.trim() || row.title,
    status: row.record_status === "completed" ? "completed" : "pending",
    completedAt: row.completed_at,
    createdAt: row.created_at
  };
}

export async function createTask(env: Env, input: CreateTaskInput) {
  const title = input.title?.trim();
  const scheduleTime = input.scheduleTime?.trim();
  const requestedVoiceContent = input.voiceContent?.trim();

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

  const id = randomId("task");
  const childId = input.childId;

  if (!childId) {
    throw new Error("Task target is required.");
  }

  await env.DB.prepare(
    `INSERT INTO tasks
      (id, child_id, title, schedule_time, repeat_type, voice_enable, voice_content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      childId,
      title,
      scheduleTime,
      input.repeatType,
      input.voiceEnabled === false ? 0 : 1,
      voiceContent
    )
    .run();

  return getTaskById(env, id);
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
      task_records.completed_at AS completed_at
     FROM tasks
     LEFT JOIN task_records
      ON task_records.task_id = tasks.id
      AND task_records.date = ?
     WHERE tasks.active = 1
      AND tasks.child_id = ?
     ORDER BY tasks.schedule_time ASC`
  )
    .bind(date, childId)
    .all<TaskRow>();

  return result.results.filter((row) => shouldRunOnDate(env, row)).map(toTaskDto);
}

export async function getTodayTasksForUser(env: Env, user: AuthUser, requestedChildId?: string) {
  const childId = await resolveTaskChildId(env, user, requestedChildId);

  if (!childId) {
    return [];
  }

  return getTodayTasks(env, childId);
}

export async function listTasksForUser(
  env: Env,
  user: AuthUser,
  filters: { childId?: string; status?: string; keyword?: string; repeatType?: string }
) {
  const children = await listChildren(env, user);
  const selectedChildren = filters.childId
    ? children.filter((child) => child.id === filters.childId)
    : children;
  const groups = await Promise.all(selectedChildren.map((child) => getTodayTasks(env, child.id)));
  const keyword = filters.keyword?.trim().toLocaleLowerCase() || "";

  return groups
    .flat()
    .filter((task) => !filters.status || task.status === filters.status)
    .filter((task) => !filters.repeatType || task.repeatType === filters.repeatType)
    .filter((task) => !keyword || task.title.toLocaleLowerCase().includes(keyword))
    .sort((left, right) => left.scheduleTime.localeCompare(right.scheduleTime));
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
      task_records.completed_at AS completed_at
     FROM tasks
     LEFT JOIN task_records
      ON task_records.task_id = tasks.id
      AND task_records.date = ?
     WHERE tasks.id = ?
      AND tasks.active = 1
     LIMIT 1`
  )
    .bind(date, taskId)
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

async function canAccessChild(env: Env, user: AuthUser, childId: string) {
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
