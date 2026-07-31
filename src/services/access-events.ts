import type { AuthUser, Env } from "../types";
import { randomId } from "../utils";

const maximumMetadataLength = 2_000;

export interface AccessEventInput {
  user?: AuthUser | null;
  eventName: string;
  clientType?: string;
  route?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: "success" | "failure";
  metadata?: Record<string, unknown>;
  userAgent?: string;
  sessionId?: string;
}

export interface AccessEventDto {
  id: string;
  eventName: string;
  clientType: string;
  route: string | null;
  resourceType: string | null;
  resourceId: string | null;
  outcome: "success" | "failure";
  metadata: Record<string, unknown>;
  occurredAt: string;
  user: { id: string; username: string; displayName: string } | null;
}

function text(value: string | undefined, maxLength: number) {
  return value?.trim().slice(0, maxLength) || null;
}

function safeMetadata(value: Record<string, unknown> | undefined) {
  const result: Record<string, string | number | boolean | null> = {};

  for (const [key, item] of Object.entries(value || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (typeof item === "string") result[key] = item.slice(0, 200);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) result[key] = item;
  }

  const serialized = JSON.stringify(result);
  return serialized.length <= maximumMetadataLength ? serialized : "{}";
}

export async function recordAccessEvent(env: Env, input: AccessEventInput) {
  const eventName = text(input.eventName, 64);
  if (!eventName || !/^[a-z][a-z0-9_]*$/.test(eventName)) return;

  await env.DB.prepare(
    `INSERT INTO access_events
      (id, user_id, event_name, client_type, route, resource_type, resource_id, outcome, metadata_json, user_agent, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    randomId("access"),
    input.user?.id || null,
    eventName,
    text(input.clientType, 32) || "web",
    text(input.route, 160),
    text(input.resourceType, 40),
    text(input.resourceId, 80),
    input.outcome === "failure" ? "failure" : "success",
    safeMetadata(input.metadata),
    text(input.userAgent, 240),
    text(input.sessionId, 80)
  ).run();
}

export async function recordApiAccessEvent(
  env: Env,
  request: Request,
  url: URL,
  status: number,
  user?: AuthUser | null
) {
  if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/access-events") || url.pathname.startsWith("/api/auth")) {
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(claim|complete|remind|status|voice-reminder-completed))?$/);
  const submissionMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)(?:\/(photos|submit|review|resubmit|finalize-review))?$/);
  const familyMemberMatch = url.pathname.match(/^\/api\/families\/([^/]+)\/members\/([^/]+)$/);
  const familyMembersMatch = url.pathname.match(/^\/api\/families\/([^/]+)\/members$/);
  const familyChildrenMatch = url.pathname.match(/^\/api\/families\/([^/]+)\/children$/);
  const familyMatch = url.pathname.match(/^\/api\/families\/([^/]+)$/);
  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  let eventName: string | undefined;
  let resourceType: string | undefined;
  let resourceId: string | undefined;

  if (url.pathname === "/api/tasks" && request.method === "GET") {
    if (url.searchParams.get("keyword")) {
      eventName = "task_searched";
      resourceType = "task";
    }
  } else if (url.pathname === "/api/tasks" && request.method === "POST") {
    eventName = "task_created";
    resourceType = "task";
  } else if (taskMatch) {
    resourceType = "task";
    resourceId = taskMatch[1];
    const action = taskMatch[2];
    eventName = action === "claim" ? "task_claimed"
      : action === "complete" ? "task_completed"
      : action === "remind" ? "task_reminder_sent"
      : action === "status" ? "task_status_updated"
      : action === "voice-reminder-completed" ? "task_voice_reminder_completed"
      : request.method === "GET" && url.searchParams.get("purpose") === "detail" ? "task_detail_viewed"
      : request.method === "PATCH" ? "task_updated"
      : request.method === "DELETE" ? "task_deleted"
      : undefined;
  } else if (url.pathname === "/api/submissions" && request.method === "GET") {
    if (url.searchParams.get("keyword")) {
      eventName = "submission_searched";
      resourceType = "submission";
    }
  } else if (submissionMatch) {
    resourceType = "submission";
    resourceId = submissionMatch[1];
    const action = submissionMatch[2];
    eventName = action === "submit" ? "submission_submitted"
      : action === "review" ? "submission_review_submitted"
      : action === "resubmit" ? "submission_reopened"
      : action === "finalize-review" ? "submission_review_finalized"
      : request.method === "DELETE" ? "submission_deleted"
      : undefined;
  } else if (familyMemberMatch) {
    resourceType = "family_member";
    resourceId = familyMemberMatch[2];
    eventName = request.method === "PATCH" ? "family_member_updated"
      : request.method === "DELETE" ? "family_member_removed"
      : undefined;
  } else if (familyMembersMatch) {
    resourceType = "family";
    resourceId = familyMembersMatch[1];
    eventName = request.method === "POST" ? "family_member_added" : undefined;
  } else if (familyChildrenMatch) {
    resourceType = "family";
    resourceId = familyChildrenMatch[1];
    eventName = request.method === "POST" ? "family_child_created" : undefined;
  } else if (familyMatch) {
    resourceType = "family";
    resourceId = familyMatch[1];
    eventName = request.method === "PATCH" ? "family_updated"
      : request.method === "DELETE" ? "family_deleted"
      : undefined;
  } else if (url.pathname === "/api/families") {
    eventName = request.method === "POST" ? "family_created" : undefined;
    resourceType = "family";
  } else if (adminUserMatch) {
    eventName = request.method === "PATCH" ? "user_updated"
      : request.method === "DELETE" ? "user_deleted"
      : undefined;
    resourceType = "user";
    resourceId = adminUserMatch[1];
  } else if (url.pathname === "/api/admin/users") {
    eventName = request.method === "POST" ? "user_created" : undefined;
    resourceType = "user";
  }

  if (!eventName) return;

  await recordAccessEvent(env, {
    user,
    eventName,
    clientType: request.headers.get("x-starbud-client") || "web",
    route: url.pathname,
    resourceType,
    resourceId,
    outcome: status >= 200 && status < 400 ? "success" : "failure",
    metadata: { method: request.method, status, filtered: Boolean(url.searchParams.get("keyword")), origin: "server" },
    userAgent: request.headers.get("user-agent") || undefined,
    sessionId: request.headers.get("x-starbud-session-id") || undefined
  });
}

export async function listAccessEvents(
  env: Env,
  filters: { eventName?: string; clientType?: string; userId?: string; from?: string; to?: string; page: number; pageSize: number }
) {
  const clauses = ["1 = 1"];
  const values: string[] = [];

  if (filters.eventName) {
    clauses.push("access_events.event_name = ?");
    values.push(filters.eventName);
  }
  if (filters.clientType) {
    clauses.push("access_events.client_type = ?");
    values.push(filters.clientType);
  }
  if (filters.userId) {
    clauses.push("access_events.user_id = ?");
    values.push(filters.userId);
  }
  if (filters.from) {
    clauses.push("access_events.occurred_at >= ?");
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push("access_events.occurred_at <= ?");
    values.push(filters.to);
  }

  const where = clauses.join(" AND ");
  const offset = (filters.page - 1) * filters.pageSize;
  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT access_events.*, users.username, users.display_name
       FROM access_events
       LEFT JOIN users ON users.id = access_events.user_id
       WHERE ${where}
       ORDER BY access_events.occurred_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...values, filters.pageSize, offset).all<{
      id: string; event_name: string; client_type: string; route: string | null;
      resource_type: string | null; resource_id: string | null; outcome: "success" | "failure";
      metadata_json: string; occurred_at: string; user_id: string | null; username: string | null; display_name: string | null;
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM access_events WHERE ${where}`).bind(...values).first<{ count: number }>()
  ]);

  return {
    events: rows.results.map((row): AccessEventDto => ({
      id: row.id,
      eventName: row.event_name,
      clientType: row.client_type,
      route: row.route,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      outcome: row.outcome,
      metadata: JSON.parse(row.metadata_json || "{}") as Record<string, unknown>,
      occurredAt: row.occurred_at,
      user: row.user_id ? { id: row.user_id, username: row.username || "", displayName: row.display_name || row.username || "" } : null
    })),
    total: total?.count || 0
  };
}
