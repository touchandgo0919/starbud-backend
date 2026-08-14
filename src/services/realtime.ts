import type { Env } from "../types";
import { ensureNotificationReminderRecords, markPendingReminderPush } from "./reminder-records";

export interface RealtimeSignal {
  type: "notifications_changed";
  createdAt: string;
}

export class UserRealtime {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request) {
    if (request.method === "POST") {
      const message = await request.text();
      let connectionCount = 0;
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(message);
          connectionCount += 1;
        } catch {
          // Closed sockets are removed by the runtime; one stale connection
          // must not prevent delivery to the remaining app windows.
        }
      }
      return Response.json({ connectionCount });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "connected" }));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "starbud-realtime" }
    });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") socket.send("pong");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason);
  }
}

export async function publishNotificationChanged(
  env: Env,
  userId?: string | null,
  notificationIds: string | string[] = []
) {
  if (!userId) return;
  const ids = Array.isArray(notificationIds) ? notificationIds : [notificationIds];
  if (!ids.length) return;
  try {
    await ensureNotificationReminderRecords(env, userId, ids);
    if (!env.USER_REALTIME) {
      await markPendingReminderPush(env, userId, ids, { connectionCount: 0 });
      return;
    }
    const stub = env.USER_REALTIME.getByName(userId);
    const signal: RealtimeSignal = {
      type: "notifications_changed",
      createdAt: new Date().toISOString()
    };
    const response = await stub.fetch("https://realtime.internal/publish", {
      method: "POST",
      body: JSON.stringify(signal)
    });
    const result: { connectionCount?: number } = await response.json<{ connectionCount?: number }>().catch(() => ({}));
    await markPendingReminderPush(env, userId, ids, { connectionCount: result.connectionCount || 0 });
  } catch (error) {
    // Realtime delivery is an acceleration path. The persisted notification and
    // the desktop app's polling fallback must remain successful if it is down.
    console.error("Failed to publish realtime notification signal:", error);
    await markPendingReminderPush(env, userId, ids, {
      connectionCount: 0,
      error: error instanceof Error ? error.message : "实时推送失败"
    }).catch(() => undefined);
  }
}
