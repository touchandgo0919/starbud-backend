import type { Env } from "../types";

export interface RealtimeSignal {
  type: "notifications_changed";
  createdAt: string;
}

export class UserRealtime {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request) {
    if (request.method === "POST") {
      const message = await request.text();
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(message);
        } catch {
          // Closed sockets are removed by the runtime; one stale connection
          // must not prevent delivery to the remaining app windows.
        }
      }
      return new Response(null, { status: 204 });
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

export async function publishNotificationChanged(env: Env, userId?: string | null) {
  if (!userId || !env.USER_REALTIME) return;
  try {
    const stub = env.USER_REALTIME.getByName(userId);
    const signal: RealtimeSignal = {
      type: "notifications_changed",
      createdAt: new Date().toISOString()
    };
    await stub.fetch("https://realtime.internal/publish", {
      method: "POST",
      body: JSON.stringify(signal)
    });
  } catch (error) {
    // Realtime delivery is an acceleration path. The persisted notification and
    // the desktop app's polling fallback must remain successful if it is down.
    console.error("Failed to publish realtime notification signal:", error);
  }
}
