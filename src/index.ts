import { emptyResponse, jsonResponse, notFound } from "./http";
import { handleAuth } from "./routes/auth";
import { handleFamilies } from "./routes/families";
import { handleTasks } from "./routes/tasks";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return emptyResponse({ status: 204 });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "starbud-backend"
      });
    }

    const authResponse = await handleAuth(request, env, url);

    if (authResponse) {
      return authResponse;
    }

    const familyResponse = await handleFamilies(request, env, url);

    if (familyResponse) {
      return familyResponse;
    }

    const taskResponse = await handleTasks(request, env, url);

    if (taskResponse) {
      return taskResponse;
    }

    return notFound();
  }
};
