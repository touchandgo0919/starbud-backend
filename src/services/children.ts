import type { AuthUser, ChildDto, Env } from "../types";

export async function childIdForUser(env: Env, user: AuthUser) {
  if (user.role !== "child") {
    return null;
  }

  const child = await env.DB.prepare(
    "SELECT id FROM children WHERE child_user_id = ? LIMIT 1"
  )
    .bind(user.id)
    .first<{ id: string }>();

  return child?.id || null;
}

export async function listChildren(env: Env, user: AuthUser) {
  const childId = await childIdForUser(env, user);
  const query = user.role === "admin"
    ? env.DB.prepare("SELECT id, name, device_id FROM children ORDER BY name ASC")
    : childId
    ? env.DB.prepare("SELECT id, name, device_id FROM children WHERE id = ? ORDER BY name ASC").bind(childId)
    : env.DB.prepare(
        `SELECT DISTINCT children.id, children.name, children.device_id
         FROM children
         INNER JOIN family_members child_member
          ON child_member.user_id = children.child_user_id
         INNER JOIN family_members parent_member
          ON parent_member.family_id = child_member.family_id
         WHERE parent_member.user_id = ?
         ORDER BY children.name ASC`
      ).bind(user.id);

  const result = await query.all<{ id: string; name: string; device_id: string | null }>();

  return result.results.map<ChildDto>((row) => ({
    id: row.id,
    name: row.name,
    deviceId: row.device_id
  }));
}
