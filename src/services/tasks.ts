import { randomId } from "../utils";
import type { CreateTaskInput, Env, TaskDto, TaskRow } from "../types";
import { ensureDemoFamily } from "../db/seed";

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
