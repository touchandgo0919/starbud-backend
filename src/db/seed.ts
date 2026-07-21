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
    displayName: "王亚梅",
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
    displayName: "赵又宁",
    role: "child"
  },
  {
    id: "user-zhaojianing",
    username: "zhaojianing",
    displayName: "赵嘉宁",
    role: "child"
  }
];

const defaultChildren = [
  {
    id: "child-zhaoyouning",
    userId: "user-zhaotao",
    name: "赵又宁",
    deviceId: "mac-zhaoyouning"
  },
  {
    id: "child-zhaojianing",
    userId: "user-zhaotao",
    name: "赵嘉宁",
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
  for (const user of defaultUsers) {
    const passwordHash = await hashPassword(`${user.username}@2026`);

    await env.DB.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(username)
       DO UPDATE SET display_name = excluded.display_name, role = excluded.role`
    )
      .bind(user.id, user.username, passwordHash, user.displayName, user.role)
      .run();
  }

  for (const child of defaultChildren) {
    await env.DB.prepare(
      `INSERT INTO children (id, user_id, name, device_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET name = excluded.name, device_id = excluded.device_id`
    )
      .bind(child.id, child.userId, child.name, child.deviceId)
      .run();
  }
}
