import type { Env } from "../types";
import { localTimestamp, randomId } from "../utils";

export const LOGIN_FAILURE_WINDOW_MINUTES = 15;
export const MAX_ACCOUNT_FAILURES = 5;
export const MAX_IP_FAILURES = 20;

export function loginClientIp(request: Request) {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function usernameKey(username: string) {
  return username.trim().toLocaleLowerCase();
}

function windowStart(now = new Date()) {
  return localTimestamp(new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MINUTES * 60_000));
}

/** 返回 true 表示该账号或来源 IP 在窗口期内失败次数过多，应暂时拒绝登录。 */
export async function isLoginThrottled(env: Env, username: string, clientIp: string) {
  const since = windowStart();
  const [account, ip] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM login_failures WHERE username_key = ? AND failed_at >= ?")
      .bind(usernameKey(username), since).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM login_failures WHERE client_ip = ? AND failed_at >= ?")
      .bind(clientIp, since).first<{ count: number }>()
  ]);
  return (Number(account?.count) || 0) >= MAX_ACCOUNT_FAILURES || (Number(ip?.count) || 0) >= MAX_IP_FAILURES;
}

export async function recordLoginFailure(env: Env, username: string, clientIp: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO login_failures (id, username_key, client_ip, failed_at) VALUES (?, ?, ?, ?)")
      .bind(randomId("login-failure"), usernameKey(username), clientIp, localTimestamp()),
    // 顺带清理窗口期之前的旧记录，避免表无限增长。
    env.DB.prepare("DELETE FROM login_failures WHERE failed_at < ?").bind(windowStart())
  ]);
}

export async function clearLoginFailures(env: Env, username: string) {
  await env.DB.prepare("DELETE FROM login_failures WHERE username_key = ?").bind(usernameKey(username)).run();
}
