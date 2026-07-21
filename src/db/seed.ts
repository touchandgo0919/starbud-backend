import type { Env, UserRole } from "../types";
import { hashPassword } from "../services/auth";

const defaultUsers: Array<{
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}> = [
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
    name: "赵佑宁",
    deviceId: "mac-zhaoyouning"
  },
  {
    id: "child-zhaojianing",
    userId: "user-zhaotao",
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

  for (const user of defaultUsers) {
    const passwordHash = await hashPassword(`${user.username}${passwordSuffix}`);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(user.id, user.username, passwordHash, user.displayName, user.role)
      .run();
  }

  for (const child of defaultChildren) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO children (id, user_id, name, device_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(child.id, child.userId, child.name, child.deviceId)
      .run();
  }
}
