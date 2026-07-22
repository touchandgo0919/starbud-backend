import { randomId } from "../utils";
import type { AuthUser, CreateTaskInput, Env, TaskDto, TaskRow } from "../types";
import { ensureDemoFamily } from "../db/seed";
import { childIdForUser } from "./children";
import { listChildren } from "./children";

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toTaskDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    childId: row.child_id,
    title: row.title,
    scheduleTime: row.schedule_time,
    repeatType: row.repeat_type,
    voiceEnabled: Boolean(row.voice_enable),
    status: row.record_status === "completed" ? "completed" : "pending",
    completedAt: row.completed_at,
    createdAt: row.created_at
  };
}

export async function createTask(env: Env, input: CreateTaskInput) {
  const demo = await ensureDemoFamily(env);
  const title = input.title?.trim();
  const scheduleTime = input.scheduleTime?.trim();

  if (!title) {
    throw new Error("Task title is required.");
  }

  if (!scheduleTime || !/^\d{2}:\d{2}$/.test(scheduleTime)) {
    throw new Error("scheduleTime must use HH:mm format.");
  }

  const id = randomId("task");
  const childId = input.childId || demo.childId;

  await env.DB.prepare(
    `INSERT INTO tasks
      (id, child_id, title, schedule_time, repeat_type, voice_enable)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      childId,
      title,
      scheduleTime,
      input.repeatType || "daily",
      input.voiceEnabled === false ? 0 : 1
    )
    .run();

  return getTaskById(env, id);
}

export async function createTaskForUser(env: Env, user: AuthUser, input: CreateTaskInput) {
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
  const demo = await ensureDemoFamily(env);
  const date = todayKey();

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
    .bind(date, childId || demo.childId)
    .all<TaskRow>();

  return result.results.map(toTaskDto);
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

  if (!existing) {
    return null;
  }

  const date = todayKey();
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
  const date = todayKey();
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
