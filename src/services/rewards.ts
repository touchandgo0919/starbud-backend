import { localTimestamp, randomId } from "../utils";
import type { AuthUser, Env } from "../types";

type RewardSettingRow = { task_points: number; streak_days: number; streak_bonus_points: number };
type RewardRow = { id: string; title: string; point_cost: number; description: string; active: number };

function normalizePositive(value: unknown, fallback: number, max: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= max ? number : fallback;
}

async function childForUser(env: Env, user: AuthUser) {
  if (user.role !== "child") return null;
  return env.DB.prepare("SELECT id FROM children WHERE child_user_id = ? LIMIT 1").bind(user.id).first<{ id: string }>();
}

async function familyForChild(env: Env, childId: string) {
  return env.DB.prepare(
    `SELECT family_members.family_id
     FROM children
     INNER JOIN family_members ON family_members.user_id = children.child_user_id
     WHERE children.id = ?
     ORDER BY family_members.created_at ASC
     LIMIT 1`
  ).bind(childId).first<{ family_id: string }>();
}

async function canManageChild(env: Env, user: AuthUser, childId: string) {
  if (user.role === "admin") return true;
  if (user.role !== "parent") return false;
  const row = await env.DB.prepare(
    `SELECT 1
     FROM children
     INNER JOIN family_members parent_member ON parent_member.user_id = ?
     INNER JOIN family_members child_member
       ON child_member.family_id = parent_member.family_id
      AND child_member.user_id = children.child_user_id
     WHERE children.id = ? LIMIT 1`
  ).bind(user.id, childId).first();
  return Boolean(row);
}

async function settingsForFamily(env: Env, familyId: string): Promise<RewardSettingRow> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO family_reward_settings (family_id, task_points, streak_days, streak_bonus_points, updated_at)
     VALUES (?, 1, 3, 2, ?)`
  ).bind(familyId, localTimestamp()).run();
  return (await env.DB.prepare("SELECT task_points, streak_days, streak_bonus_points FROM family_reward_settings WHERE family_id = ?")
    .bind(familyId).first<RewardSettingRow>())!;
}

async function balanceForChild(env: Env, childId: string) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS balance FROM child_point_ledger WHERE child_id = ?")
    .bind(childId).first<{ balance: number }>();
  return row?.balance || 0;
}

export async function getRewardBalances(env: Env, user: AuthUser) {
  const ownChild = await childForUser(env, user);
  const rows = ownChild
    ? await env.DB.prepare(
      `SELECT children.id, COALESCE(SUM(child_point_ledger.points), 0) AS balance
       FROM children
       LEFT JOIN child_point_ledger ON child_point_ledger.child_id = children.id
       WHERE children.id = ?
       GROUP BY children.id`
    ).bind(ownChild.id).all<{ id: string; balance: number }>()
    : await env.DB.prepare(
      `SELECT children.id, COALESCE(SUM(child_point_ledger.points), 0) AS balance
       FROM children
       LEFT JOIN child_point_ledger ON child_point_ledger.child_id = children.id
       WHERE ? = 'admin'
          OR EXISTS (
            SELECT 1
            FROM family_members parent_member
            INNER JOIN family_members child_member ON child_member.family_id = parent_member.family_id
            WHERE parent_member.user_id = ? AND child_member.user_id = children.child_user_id
          )
       GROUP BY children.id`
    ).bind(user.role, user.id).all<{ id: string; balance: number }>();
  return rows.results.map((row) => ({ childId: row.id, balance: Number(row.balance) || 0 }));
}

function dtoReward(row: RewardRow) {
  return { id: row.id, title: row.title, pointCost: row.point_cost, description: row.description, active: Boolean(row.active) };
}

export async function getRewardCenter(env: Env, user: AuthUser, requestedChildId?: string) {
  const ownChild = await childForUser(env, user);
  const childId = ownChild?.id || requestedChildId;
  if (!childId || !(ownChild || await canManageChild(env, user, childId))) throw new Error("无权查看该儿童的星芽积分。");
  const family = await familyForChild(env, childId);
  if (!family) throw new Error("该儿童尚未加入家庭。");
  const [settings, balance, rewards, redemptions, entries] = await Promise.all([
    settingsForFamily(env, family.family_id),
    balanceForChild(env, childId),
    env.DB.prepare("SELECT id, title, point_cost, description, active FROM family_rewards WHERE family_id = ? ORDER BY active DESC, created_at ASC")
      .bind(family.family_id).all<RewardRow>(),
    env.DB.prepare(
      `SELECT reward_redemptions.id, reward_redemptions.reward_title, reward_redemptions.point_cost,
              reward_redemptions.status, reward_redemptions.requested_at, reward_redemptions.confirmed_at,
              reward_redemptions.note, children.name AS child_name
       FROM reward_redemptions INNER JOIN children ON children.id = reward_redemptions.child_id
       WHERE reward_redemptions.family_id = ? ${ownChild ? "AND reward_redemptions.child_id = ?" : ""}
       ORDER BY reward_redemptions.requested_at DESC LIMIT 50`
    ).bind(family.family_id, ...(ownChild ? [childId] : [])).all(),
    env.DB.prepare(
      `SELECT entry_type, points, description, created_at
       FROM child_point_ledger WHERE child_id = ?
       ORDER BY created_at DESC LIMIT 100`
    ).bind(childId).all<{ entry_type: string; points: number; description: string; created_at: string }>()
  ]);
  return {
    childId,
    balance,
    settings: { taskPoints: settings.task_points, streakDays: settings.streak_days, streakBonusPoints: settings.streak_bonus_points },
    rewards: rewards.results.map(dtoReward),
    redemptions: redemptions.results.map((row) => ({
      id: String(row.id), title: String(row.reward_title), pointCost: Number(row.point_cost), status: String(row.status),
      requestedAt: String(row.requested_at), confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
      note: String(row.note || ""), childName: String(row.child_name)
    })),
    entries: entries.results.map((row) => ({ type: row.entry_type, points: row.points, description: row.description, createdAt: row.created_at }))
  };
}

export async function updateRewardSettings(env: Env, user: AuthUser, familyId: string, input: Record<string, unknown>) {
  if (user.role === "child") throw new Error("仅家长可以设置奖励规则。");
  const family = await env.DB.prepare(
    user.role === "admin" ? "SELECT id FROM families WHERE id = ?" : `SELECT families.id FROM families INNER JOIN family_members ON family_members.family_id = families.id WHERE families.id = ? AND family_members.user_id = ?`
  ).bind(familyId, ...(user.role === "admin" ? [] : [user.id])).first();
  if (!family) throw new Error("无权维护该家庭奖励。");
  const current = await settingsForFamily(env, familyId);
  const taskPoints = normalizePositive(input.taskPoints, current.task_points, 100);
  const streakDays = normalizePositive(input.streakDays, current.streak_days, 30);
  const streakBonusPoints = normalizePositive(input.streakBonusPoints, current.streak_bonus_points, 500);
  await env.DB.prepare(
    `UPDATE family_reward_settings SET task_points = ?, streak_days = ?, streak_bonus_points = ?, updated_at = ? WHERE family_id = ?`
  ).bind(taskPoints, streakDays, streakBonusPoints, localTimestamp(), familyId).run();
}

export async function saveFamilyReward(env: Env, user: AuthUser, familyId: string, input: Record<string, unknown>, rewardId?: string) {
  await updateRewardSettings(env, user, familyId, {});
  const title = String(input.title || "").trim();
  const pointCost = normalizePositive(input.pointCost, 0, 100000);
  const description = String(input.description || "").trim().slice(0, 120);
  if (!title || title.length > 40 || !pointCost) throw new Error("请填写奖励名称和有效积分。");
  if (rewardId) {
    await env.DB.prepare(`UPDATE family_rewards SET title = ?, point_cost = ?, description = ?, active = ?, updated_at = ? WHERE id = ? AND family_id = ?`)
      .bind(title, pointCost, description, input.active === false ? 0 : 1, localTimestamp(), rewardId, familyId).run();
    return rewardId;
  }
  const id = randomId("reward");
  await env.DB.prepare(
    `INSERT INTO family_rewards (id, family_id, title, point_cost, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, familyId, title, pointCost, description, localTimestamp(), localTimestamp()).run();
  return id;
}

export async function requestRewardRedemption(env: Env, user: AuthUser, rewardId: string, note?: string) {
  const child = await childForUser(env, user);
  if (!child) throw new Error("仅儿童账号可以申请兑换。");
  const family = await familyForChild(env, child.id);
  const reward = family && await env.DB.prepare("SELECT id, title, point_cost, active FROM family_rewards WHERE id = ? AND family_id = ? LIMIT 1")
    .bind(rewardId, family.family_id).first<{ id: string; title: string; point_cost: number; active: number }>();
  if (!family || !reward || !reward.active) throw new Error("该奖励目前不可兑换。");
  if ((await balanceForChild(env, child.id)) < reward.point_cost) throw new Error("星芽积分不足，继续完成任务就能兑换啦。");
  const id = randomId("redeem");
  await env.DB.prepare(
    `INSERT INTO reward_redemptions (id, family_id, child_id, reward_id, reward_title, point_cost, status, requested_at, note)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, family.family_id, child.id, reward.id, reward.title, reward.point_cost, localTimestamp(), String(note || "").trim().slice(0, 120)).run();
  return id;
}

export async function confirmRewardRedemption(env: Env, user: AuthUser, redemptionId: string, approved: boolean) {
  if (user.role === "child") throw new Error("仅家长可以确认兑换。");
  const redemption = await env.DB.prepare(
    `SELECT reward_redemptions.* FROM reward_redemptions
     ${user.role === "admin" ? "" : "INNER JOIN family_members ON family_members.family_id = reward_redemptions.family_id AND family_members.user_id = ?"}
     WHERE reward_redemptions.id = ? LIMIT 1`
  ).bind(...(user.role === "admin" ? [redemptionId] : [user.id, redemptionId])).first<{
    id: string; family_id: string; child_id: string; point_cost: number; status: string; reward_title: string;
  }>();
  if (!redemption) throw new Error("未找到兑换申请。");
  if (redemption.status !== "pending") throw new Error("该兑换申请已处理。");
  if (approved) {
    if ((await balanceForChild(env, redemption.child_id)) < redemption.point_cost) throw new Error("当前积分不足，无法确认兑换。");
    await env.DB.batch([
      env.DB.prepare("UPDATE reward_redemptions SET status = 'approved', confirmed_at = ?, confirmed_by = ? WHERE id = ?")
        .bind(localTimestamp(), user.id, redemptionId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO child_point_ledger (id, family_id, child_id, entry_type, reference_key, points, description, created_at)
         VALUES (?, ?, ?, 'redemption', ?, ?, ?, ?)`
      ).bind(randomId("points"), redemption.family_id, redemption.child_id, redemption.id, -redemption.point_cost, `兑换：${redemption.reward_title}`, localTimestamp())
    ]);
  } else {
    await env.DB.prepare("UPDATE reward_redemptions SET status = 'rejected', confirmed_at = ?, confirmed_by = ? WHERE id = ?")
      .bind(localTimestamp(), user.id, redemptionId).run();
  }
}

export async function awardTaskCompletionPoints(env: Env, childId: string, taskId: string, taskDate: string) {
  const family = await familyForChild(env, childId);
  if (!family) return;
  const settings = await settingsForFamily(env, family.family_id);
  const now = localTimestamp();
  const task = await env.DB.prepare("SELECT title FROM tasks WHERE id = ? LIMIT 1").bind(taskId).first<{ title: string }>();
  const taskDescription = `完成任务：${task?.title || "任务"}（${taskDate}）`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO child_point_ledger (id, family_id, child_id, entry_type, reference_key, points, description, created_at)
     VALUES (?, ?, ?, 'task_completed', ?, ?, ?, ?)`
  ).bind(randomId("points"), family.family_id, childId, `${taskId}:${taskDate}`, settings.task_points, taskDescription, now).run();
  const dates = await env.DB.prepare(
    `SELECT DISTINCT task_records.date FROM task_records INNER JOIN tasks ON tasks.id = task_records.task_id
     WHERE tasks.child_id = ? AND task_records.status = 'completed' AND task_records.date <= ?
     ORDER BY task_records.date DESC LIMIT ?`
  ).bind(childId, taskDate, settings.streak_days).all<{ date: string }>();
  if (dates.results.length !== settings.streak_days) return;
  const expected = new Date(`${taskDate}T12:00:00`);
  const consecutive = dates.results.every((row, index) => {
    const value = new Date(expected); value.setDate(value.getDate() - index);
    return row.date === value.toISOString().slice(0, 10);
  });
  if (consecutive) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO child_point_ledger (id, family_id, child_id, entry_type, reference_key, points, description, created_at)
       VALUES (?, ?, ?, 'streak_bonus', ?, ?, ?, ?)`
    ).bind(randomId("points"), family.family_id, childId, taskDate, settings.streak_bonus_points, `连续完成 ${settings.streak_days} 天奖励（${taskDate}）`, now).run();
  }
}
