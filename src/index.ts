import { emptyResponse, jsonResponse, notFound } from "./http";
import { handleAuth } from "./routes/auth";
import { handleFamilies } from "./routes/families";
import { handleTasks } from "./routes/tasks";
import { handleUsers } from "./routes/users";
import { isAuthConfigured } from "./services/auth";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return emptyResponse({ status: 204 });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const authConfigured = isAuthConfigured(env);
      return jsonResponse({
        ok: authConfigured,
        service: "starbud-backend",
        checks: {
          authentication: authConfigured ? "ready" : "not_configured"
        }
      }, { status: authConfigured ? 200 : 503 });
    }

    const authResponse = await handleAuth(request, env, url);

    if (authResponse) {
      return authResponse;
    }

    const familyResponse = await handleFamilies(request, env, url);

    if (familyResponse) {
      return familyResponse;
    }

    const userResponse = await handleUsers(request, env, url);

    if (userResponse) {
      return userResponse;
    }

    const taskResponse = await handleTasks(request, env, url);

    if (taskResponse) {
      return taskResponse;
    }

    return notFound();
  }
};
