import { randomId } from "../utils";
import type { AuthUser, Env, FamilyDto, FamilyMemberDto, FamilyRow, UserRow } from "../types";

const DEFAULT_RELATIONSHIPS = {
  parent: "家长",
  child: "孩子"
} as const;

export async function listFamilies(env: Env, user: AuthUser) {
  const result = await env.DB.prepare(
    `SELECT families.*
     FROM families
     INNER JOIN family_members ON family_members.family_id = families.id
     WHERE family_members.user_id = ?
     ORDER BY families.created_at ASC`
  )
    .bind(user.id)
    .all<FamilyRow>();

  return Promise.all(result.results.map((family) => toFamilyDto(env, family, user)));
}

export async function createFamily(env: Env, user: AuthUser, name?: string) {
  requireParent(user);
  const normalizedName = normalizeName(name);
  const id = randomId("family");

  await env.DB.prepare(
    `INSERT INTO families (id, name, created_by)
     VALUES (?, ?, ?)`
  )
    .bind(id, normalizedName, user.id)
    .run();

  await env.DB.prepare(
    `INSERT INTO family_members (family_id, user_id, relationship)
     VALUES (?, ?, ?)`
  )
    .bind(id, user.id, DEFAULT_RELATIONSHIPS.parent)
    .run();

  return getFamilyForUser(env, id, user);
}

export async function renameFamily(env: Env, user: AuthUser, familyId: string, name?: string) {
  await requireFamilyManager(env, user, familyId);
  const normalizedName = normalizeName(name);

  await env.DB.prepare("UPDATE families SET name = ? WHERE id = ?")
    .bind(normalizedName, familyId)
    .run();

  return getFamilyForUser(env, familyId, user);
}

export async function deleteFamily(env: Env, user: AuthUser, familyId: string) {
  requireParent(user);

  const result = await env.DB.prepare(
    `DELETE FROM families
     WHERE id = ?
      AND created_by = ?
      AND is_default = 0`
  )
    .bind(familyId, user.id)
    .run();

  return result.meta.changes > 0;
}

export async function addFamilyMember(
  env: Env,
  user: AuthUser,
  familyId: string,
  username?: string,
  relationship?: string
) {
  await requireFamilyManager(env, user, familyId);
  const normalizedUsername = username?.trim();

  if (!normalizedUsername) {
    throw new Error("请输入成员用户名。");
  }

  const member = await env.DB.prepare(
    "SELECT * FROM users WHERE username = ? LIMIT 1"
  )
    .bind(normalizedUsername)
    .first<UserRow>();

  if (!member) {
    throw new Error("未找到该用户。");
  }

  const normalizedRelationship = normalizeRelationship(
    relationship,
    DEFAULT_RELATIONSHIPS[member.role]
  );

  await env.DB.prepare(
    `INSERT INTO family_members (family_id, user_id, relationship)
     VALUES (?, ?, ?)
     ON CONFLICT(family_id, user_id)
     DO UPDATE SET relationship = excluded.relationship`
  )
    .bind(familyId, member.id, normalizedRelationship)
    .run();

  return getFamilyForUser(env, familyId, user);
}

export async function updateFamilyMember(
  env: Env,
  user: AuthUser,
  familyId: string,
  memberId: string,
  relationship?: string
) {
  await requireFamilyManager(env, user, familyId);
  const normalizedRelationship = normalizeRelationship(relationship);

  const result = await env.DB.prepare(
    `UPDATE family_members
     SET relationship = ?
     WHERE family_id = ? AND user_id = ?`
  )
    .bind(normalizedRelationship, familyId, memberId)
    .run();

  if (result.meta.changes === 0) {
    return null;
  }

  return getFamilyForUser(env, familyId, user);
}

export async function removeFamilyMember(
  env: Env,
  user: AuthUser,
  familyId: string,
  memberId: string
) {
  const family = await requireFamilyManager(env, user, familyId);

  if (family.created_by === memberId) {
    throw new Error("不能移除家庭创建者。");
  }

  const result = await env.DB.prepare(
    "DELETE FROM family_members WHERE family_id = ? AND user_id = ?"
  )
    .bind(familyId, memberId)
    .run();

  return result.meta.changes > 0;
}

async function getFamilyForUser(env: Env, familyId: string, user: AuthUser) {
  const family = await env.DB.prepare(
    `SELECT families.*
     FROM families
     INNER JOIN family_members ON family_members.family_id = families.id
     WHERE families.id = ? AND family_members.user_id = ?
     LIMIT 1`
  )
    .bind(familyId, user.id)
    .first<FamilyRow>();

  return family ? toFamilyDto(env, family, user) : null;
}

async function toFamilyDto(env: Env, family: FamilyRow, user: AuthUser): Promise<FamilyDto> {
  const result = await env.DB.prepare(
    `SELECT
      users.id,
      users.username,
      users.display_name,
      users.role,
      family_members.relationship
     FROM family_members
     INNER JOIN users ON users.id = family_members.user_id
     WHERE family_members.family_id = ?
     ORDER BY users.role DESC, users.display_name ASC, users.username ASC`
  )
    .bind(family.id)
    .all<{
      id: string;
      username: string;
      display_name: string | null;
      role: "parent" | "child";
      relationship: string;
    }>();

  const members = result.results.map<FamilyMemberDto>((member) => ({
    id: member.id,
    username: member.username,
    displayName: member.display_name || member.username,
    role: member.role,
    relationship: member.relationship,
    isOwner: member.id === family.created_by
  }));

  const isOwner = family.created_by === user.id;

  return {
    id: family.id,
    name: family.name,
    isOwner,
    canManage: user.role === "parent",
    canDelete: isOwner && !Boolean(family.is_default),
    members,
    createdAt: family.created_at
  };
}

async function requireFamilyManager(env: Env, user: AuthUser, familyId: string) {
  requireParent(user);

  const family = await env.DB.prepare(
    `SELECT families.*
     FROM families
     INNER JOIN family_members ON family_members.family_id = families.id
     WHERE families.id = ? AND family_members.user_id = ?
     LIMIT 1`
  )
    .bind(familyId, user.id)
    .first<FamilyRow>();

  if (!family) {
    throw new Error("无权维护该家庭。");
  }

  return family;
}

function requireParent(user: AuthUser) {
  if (user.role !== "parent") {
    throw new Error("仅家长可以维护家庭。");
  }
}

function normalizeName(name?: string) {
  const normalized = name?.trim();

  if (!normalized) {
    throw new Error("请输入家庭名称。");
  }

  if (normalized.length > 30) {
    throw new Error("家庭名称不能超过 30 个字符。");
  }

  return normalized;
}

function normalizeRelationship(relationship?: string, fallback?: string) {
  const normalized = relationship?.trim() || fallback;

  if (!normalized) {
    throw new Error("请输入家庭关系。");
  }

  if (normalized.length > 20) {
    throw new Error("家庭关系不能超过 20 个字符。");
  }

  return normalized;
}
