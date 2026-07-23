import type { Env, UserRole } from "../types";
import { hashPassword } from "../services/auth";

const defaultUsers: Array<{
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}> = [
  {
    id: "user-admin",
    username: "admin",
    displayName: "系统管理员",
    role: "admin"
  },
  {
    id: "user-wangyamei",
    username: "wangyamei",
    displayName: "王亚美",
    role: "parent"
  },
  {
    id: "user-zhaotao",
    username: "zhaotao",
    displayName: "赵涛",
    role: "parent"
  },
  {
    id: "user-zhaoyouning",
    username: "zhaoyouning",
    displayName: "赵佑宁",
    role: "child"
  },
  {
    id: "user-zhaojianing",
    username: "zhaojianing",
    displayName: "赵佳宁",
    role: "child"
  }
];

const defaultChildren = [
  {
    id: "child-zhaoyouning",
    userId: "user-zhaotao",
    childUserId: "user-zhaoyouning",
    name: "赵佑宁",
    deviceId: "mac-zhaoyouning"
  },
  {
    id: "child-zhaojianing",
    userId: "user-zhaotao",
    childUserId: "user-zhaojianing",
    name: "赵佳宁",
    deviceId: "mac-zhaojianing"
  }
];

export async function ensureDemoFamily(env: Env) {
  await ensureDefaultUsers(env);
  return {
    userId: "user-zhaotao",
    childId: "child-zhaoyouning"
  };
}

export async function ensureDefaultUsers(env: Env) {
  const passwordSuffix = env.INITIAL_PASSWORD_SUFFIX || "@local-dev";
  const demoUsersEnabled = env.SEED_DEMO_USERS === "true";
  const usersToSeed = defaultUsers.filter(
    (user) =>
      (user.role === "admin" && Boolean(env.ADMIN_INITIAL_PASSWORD)) ||
      (user.role !== "admin" && demoUsersEnabled)
  );

  for (const user of usersToSeed) {
    const existing = await env.DB.prepare("SELECT id FROM users WHERE id = ? LIMIT 1")
      .bind(user.id)
      .first<{ id: string }>();

    if (existing) {
      continue;
    }

    const password =
      user.role === "admin"
        ? env.ADMIN_INITIAL_PASSWORD!
        : `${user.username}${passwordSuffix}`;
    const passwordHash = await hashPassword(password);

    await env.DB.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
      .bind(user.id, user.username, passwordHash, user.displayName, user.role)
      .run();
  }

  if (!demoUsersEnabled) {
    return;
  }

  for (const child of defaultChildren) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO children (id, user_id, name, device_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(child.id, child.userId, child.name, child.deviceId)
      .run();

    await env.DB.prepare("UPDATE children SET child_user_id = ? WHERE id = ?")
      .bind(child.childUserId, child.id)
      .run();
  }

  const defaultFamilyResult = await env.DB.prepare(
    `INSERT OR IGNORE INTO families (id, name, created_by, is_default)
     VALUES ('family-zhao', '赵家', 'user-zhaotao', 1)`
  ).run();

  if (defaultFamilyResult.meta.changes > 0) {
    const defaultFamilyMembers = [
      ["user-zhaotao", "爸爸"],
      ["user-wangyamei", "妈妈"],
      ["user-zhaoyouning", "孩子"],
      ["user-zhaojianing", "孩子"]
    ];

    for (const [userId, relationship] of defaultFamilyMembers) {
      await env.DB.prepare(
        `INSERT INTO family_members (family_id, user_id, relationship)
         VALUES ('family-zhao', ?, ?)`
      )
        .bind(userId, relationship)
        .run();
    }
  }
}
