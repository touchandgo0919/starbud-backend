import type { AuthUser, ChildDto, Env } from "../types";

const childUserMap: Record<string, string> = {
  zhaoyouning: "child-zhaoyouning",
  zhaojianing: "child-zhaojianing"
};

export function childIdForUser(user: AuthUser) {
  return childUserMap[user.username] || null;
}

export async function listChildren(env: Env, user: AuthUser) {
  const childId = childIdForUser(user);
  const query = childId
    ? env.DB.prepare("SELECT id, name, device_id FROM children WHERE id = ? ORDER BY name ASC").bind(childId)
    : env.DB.prepare("SELECT id, name, device_id FROM children ORDER BY name ASC");

  const result = await query.all<{ id: string; name: string; device_id: string | null }>();

  return result.results.map<ChildDto>((row) => ({
    id: row.id,
    name: row.name,
    deviceId: row.device_id
  }));
}
