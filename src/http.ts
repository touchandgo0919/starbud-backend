const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
};

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...init.headers
    }
  });
}

export function emptyResponse(init: ResponseInit = {}) {
  return new Response(null, {
    ...init,
    headers: {
      ...jsonHeaders,
      ...init.headers
    }
  });
}

export function notFound() {
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

export function badRequest(message: string) {
  return jsonResponse({ error: message }, { status: 400 });
}

export function unauthorized(message = "Unauthorized") {
  return jsonResponse({ error: message }, { status: 401 });
}

export function forbidden(message = "Forbidden") {
  return jsonResponse({ error: message }, { status: 403 });
}

export function serviceUnavailable(message = "Service unavailable") {
  return jsonResponse({ error: message }, { status: 503 });
}
