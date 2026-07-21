import type { Env } from "../types";

const demoUserId = "user-demo";
const demoChildId = "child-demo";

export async function ensureDemoFamily(env: Env) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash)
     VALUES (?, ?, ?)`
  )
    .bind(demoUserId, "demo-parent", "demo-password-placeholder")
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO children (id, user_id, name, device_id)
     VALUES (?, ?, ?, ?)`
  )
    .bind(demoChildId, demoUserId, "小朋友", "mac-demo")
    .run();

  return {
    userId: demoUserId,
    childId: demoChildId
  };
}
