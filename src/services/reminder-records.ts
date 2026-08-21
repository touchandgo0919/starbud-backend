import { listChildren } from "./children";
import type { AuthUser, Env } from "../types";
import { localTimestamp, randomId } from "../utils";

export type ReminderResultStatus = "success" | "failed" | "skipped";

export interface ReminderRecordDto {
  id: string;
  notificationId: string | null;
  taskId: string | null;
  taskDate: string | null;
  submissionId: string | null;
  recipient: { id: string; username: string; displayName: string };
  reminderType: string;
  source: string;
  title: string;
  content: string;
  pushStatus: string;
  pushConnectionCount: number;
  pushedAt: string | null;
  pushError: string | null;
  receivedAt: string | null;
  reminderStatus: string;
  remindedAt: string | null;
  reminderError: string | null;
  createdAt: string;
}

interface ReminderRecordRow {
  id: string;
  notification_id: string | null;
  task_id: string | null;
  task_date: string | null;
  submission_id: string | null;
  recipient_user_id: string;
  username: string;
  display_name: string | null;
  reminder_type: string;
  source: string;
  title: string;
  content: string;
  push_status: string;
  push_connection_count: number;
  pushed_at: string | null;
  push_error: string | null;
  received_at: string | null;
  reminder_status: string;
  reminded_at: string | null;
  reminder_error: string | null;
  created_at: string;
}

function dto(row: ReminderRecordRow): ReminderRecordDto {
  return {
    id: row.id,
    notificationId: row.notification_id,
    taskId: row.task_id,
    taskDate: row.task_date,
    submissionId: row.submission_id,
    recipient: {
      id: row.recipient_user_id,
      username: row.username,
      displayName: row.display_name || row.username
    },
    reminderType: row.reminder_type,
    source: row.source,
    title: row.title,
    content: row.content,
    pushStatus: row.push_status,
    pushConnectionCount: row.push_connection_count,
    pushedAt: row.pushed_at,
    pushError: row.push_error,
    receivedAt: row.received_at,
    reminderStatus: row.reminder_status,
    remindedAt: row.reminded_at,
    reminderError: row.reminder_error,
    createdAt: row.created_at
  };
}

export async function ensureNotificationReminderRecords(
  env: Env,
  recipientUserId?: string,
  notificationIds: string[] = []
) {
  const clauses: string[] = ["reminder_records.id IS NULL"];
  const values: string[] = [];
  if (recipientUserId) {
    clauses.push("notifications.recipient_user_id = ?");
    values.push(recipientUserId);
  }
  if (notificationIds.length) {
    clauses.push(`notifications.id IN (${notificationIds.map(() => "?").join(",")})`);
    values.push(...notificationIds);
  }
  const statement = env.DB.prepare(
    `INSERT OR IGNORE INTO reminder_records (
       id, notification_id, submission_id, recipient_user_id, reminder_type,
       source, title, content, push_status, reminder_status, created_at
     )
     SELECT
       'reminder-' || notifications.id,
       notifications.id,
       notifications.submission_id,
       notifications.recipient_user_id,
       notifications.type,
       'server',
       notifications.title,
       notifications.content,
       'pending',
       'pending',
       notifications.created_at
     FROM notifications
     LEFT JOIN reminder_records ON reminder_records.notification_id = notifications.id
     WHERE ${clauses.join(" AND ")}`
  );
  await (values.length ? statement.bind(...values) : statement).run();
}

export async function listReminderRecords(
  env: Env,
  user: AuthUser,
  filters: {
    childId?: string;
    reminderType?: string;
    status?: string;
    keyword?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  }
) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (user.role !== "admin") {
    const childIds = (await listChildren(env, user)).map((child) => child.id);
    if (!childIds.length) return { records: [], total: 0 };
    const childUsers = await env.DB.prepare(
      `SELECT child_user_id FROM children
       WHERE id IN (${childIds.map(() => "?").join(",")}) AND child_user_id IS NOT NULL`
    ).bind(...childIds).all<{ child_user_id: string }>();
    const childUserIds = childUsers.results.map((child) => child.child_user_id);
    if (!childUserIds.length) return { records: [], total: 0 };
    clauses.push(`reminder_records.recipient_user_id IN (${childUserIds.map(() => "?").join(",")})`);
    values.push(...childUserIds);
  }
  if (filters.childId) {
    const child = await env.DB.prepare(
      "SELECT child_user_id FROM children WHERE id = ? AND child_user_id IS NOT NULL LIMIT 1"
    ).bind(filters.childId).first<{ child_user_id: string }>();
    if (!child) return { records: [], total: 0 };
    clauses.push("reminder_records.recipient_user_id = ?");
    values.push(child.child_user_id);
  }
  if (filters.reminderType) {
    clauses.push("reminder_records.reminder_type = ?");
    values.push(filters.reminderType);
  }
  if (filters.status) {
    if (new Set(["pushed", "offline", "not_applicable"]).has(filters.status)) {
      clauses.push("reminder_records.push_status = ?");
      values.push(filters.status);
    } else if (new Set(["success", "skipped"]).has(filters.status)) {
      clauses.push("reminder_records.reminder_status = ?");
      values.push(filters.status);
    } else {
      clauses.push("(reminder_records.push_status = ? OR reminder_records.reminder_status = ?)");
      values.push(filters.status, filters.status);
    }
  }
  if (filters.keyword?.trim()) {
    const keyword = `%${filters.keyword.trim()}%`;
    clauses.push("(reminder_records.title LIKE ? OR reminder_records.content LIKE ? OR users.display_name LIKE ? OR users.username LIKE ?)");
    values.push(keyword, keyword, keyword, keyword);
  }
  if (filters.from) {
    clauses.push("reminder_records.created_at >= ?");
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push("reminder_records.created_at <= ?");
    values.push(filters.to);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (filters.page - 1) * filters.pageSize;
  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT reminder_records.*, users.username, users.display_name
       FROM reminder_records
       INNER JOIN users ON users.id = reminder_records.recipient_user_id
       ${where}
       ORDER BY reminder_records.created_at DESC, reminder_records.id DESC
       LIMIT ? OFFSET ?`
    ).bind(...values, filters.pageSize, offset).all<ReminderRecordRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM reminder_records
       INNER JOIN users ON users.id = reminder_records.recipient_user_id
       ${where}`
    ).bind(...values).first<{ count: number }>()
  ]);

  return { records: rows.results.map(dto), total: total?.count || 0 };
}

export async function markPendingReminderPush(
  env: Env,
  recipientUserId: string,
  notificationIds: string[],
  result: { connectionCount: number; error?: string }
) {
  if (!notificationIds.length) return;
  const now = localTimestamp();
  const status = result.error ? "failed" : result.connectionCount > 0 ? "pushed" : "offline";
  await env.DB.prepare(
    `UPDATE reminder_records
     SET push_status = ?, push_connection_count = ?, pushed_at = ?, push_error = ?
     WHERE recipient_user_id = ?
       AND notification_id IN (${notificationIds.map(() => "?").join(",")})
       AND push_status = 'pending'`
  ).bind(status, result.connectionCount, now, result.error || null, recipientUserId, ...notificationIds).run();
}

export async function annotateNotificationReminder(
  env: Env,
  notificationId: string,
  input: { taskId?: string; taskDate?: string; source?: string }
) {
  await ensureNotificationReminderRecords(env, undefined, [notificationId]);
  await env.DB.prepare(
    `UPDATE reminder_records SET task_id = ?, task_date = ?, source = ? WHERE notification_id = ?`
  ).bind(
    input.taskId || null,
    input.taskDate || null,
    input.source?.slice(0, 32) || "server",
    notificationId
  ).run();
}

export async function markReminderReceived(env: Env, notificationId: string) {
  await ensureNotificationReminderRecords(env, undefined, [notificationId]);
  await env.DB.prepare(
    `UPDATE reminder_records SET received_at = ? WHERE notification_id = ?`
  ).bind(localTimestamp(), notificationId).run();
}

export async function reportNotificationReminderResult(
  env: Env,
  user: AuthUser,
  notificationId: string,
  input: { status: ReminderResultStatus; error?: string }
) {
  await ensureNotificationReminderRecords(env, user.id, [notificationId]);
  const result = await env.DB.prepare(
    `UPDATE reminder_records
     SET reminder_status = ?, reminded_at = ?, reminder_error = ?
     WHERE notification_id = ? AND recipient_user_id = ?`
  ).bind(input.status, localTimestamp(), input.error?.slice(0, 500) || null, notificationId, user.id).run();
  return result.meta.changes > 0;
}

export async function recordScheduledTaskReminder(
  env: Env,
  user: AuthUser,
  taskId: string,
  input: {
    taskDate?: string;
    title?: string;
    content?: string;
    attempt?: number;
    status: ReminderResultStatus;
    error?: string;
  }
) {
  const child = await env.DB.prepare(
    "SELECT id FROM children WHERE child_user_id = ? LIMIT 1"
  ).bind(user.id).first<{ id: string }>();
  if (user.role !== "child" || !child) return false;
  const task = await env.DB.prepare(
    "SELECT title FROM tasks WHERE id = ? AND child_id = ? LIMIT 1"
  ).bind(taskId, child.id).first<{ title: string }>();
  if (!task) return false;
  const now = localTimestamp();
  const attempt = Math.max(1, Math.min(20, Math.trunc(input.attempt || 1)));
  await env.DB.prepare(
    `INSERT INTO reminder_records
      (id, task_id, task_date, recipient_user_id, reminder_type, source, title, content,
       push_status, push_connection_count, reminder_status, reminded_at, reminder_error, created_at)
     VALUES (?, ?, ?, ?, 'scheduled_voice', 'desktop_app', ?, ?, 'not_applicable', 0, ?, ?, ?, ?)`
  ).bind(
    randomId("reminder"), taskId, input.taskDate || null, user.id,
    input.title?.slice(0, 120) || `第 ${attempt} 次任务提醒`,
    input.content?.slice(0, 500) || task.title,
    input.status, now, input.error?.slice(0, 500) || null, now
  ).run();
  return true;
}
