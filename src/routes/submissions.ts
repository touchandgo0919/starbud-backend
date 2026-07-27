import { badRequest, jsonResponse, notFound, unauthorized } from "../http";
import { getAuthUser } from "../services/auth";
import {
  createSubmission,
  finalizeSubmission,
  getSubmissionPhotoObject,
  listSubmissions,
  uploadSubmissionPhoto
} from "../services/submissions";
import type { Env } from "../types";

export async function handleSubmissions(request: Request, env: Env, url: URL) {
  const photoFileMatch = url.pathname.match(/^\/api\/submission-files\/([^/]+)$/);

  if (request.method === "GET" && photoFileMatch) {
    const accessToken = url.searchParams.get("token") || "";
    const result = await getSubmissionPhotoObject(env, photoFileMatch[1], accessToken);
    if (!result) {
      return notFound();
    }

    const headers = new Headers({
      "access-control-allow-origin": "*",
      "cache-control": "private, max-age=3600",
      "content-type": result.photo.content_type,
      etag: result.object.httpEtag
    });
    return new Response(result.object.body, { headers });
  }

  const createMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/submissions$/);
  const uploadMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/photos$/);
  const finalizeMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/submit$/);
  const handlesPath = url.pathname === "/api/submissions"
    || Boolean(createMatch)
    || Boolean(uploadMatch)
    || Boolean(finalizeMatch);

  if (!handlesPath) {
    return null;
  }

  const user = await getAuthUser(request, env);
  if (!user) {
    return unauthorized();
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/submissions") {
      const page = positiveInteger(url.searchParams.get("page")) || 1;
      const pageSize = Math.min(50, positiveInteger(url.searchParams.get("pageSize")) || 20);
      const result = await listSubmissions(env, user, {
        date: url.searchParams.get("date") || undefined,
        dateFrom: url.searchParams.get("dateFrom") || undefined,
        dateTo: url.searchParams.get("dateTo") || undefined,
        keyword: url.searchParams.get("keyword") || undefined,
        page,
        pageSize
      });
      return jsonResponse({
        submissions: result.submissions,
        pagination: {
          page,
          pageSize,
          total: result.total,
          hasMore: page * pageSize < result.total
        }
      });
    }

    if (request.method === "POST" && createMatch) {
      const input = (await request.json().catch(() => null)) as { note?: string } | null;
      if (!input) {
        return badRequest("Invalid JSON body.");
      }
      const submission = await createSubmission(env, user, createMatch[1], input.note);
      return submission
        ? jsonResponse({ submission }, { status: 201 })
        : notFound();
    }

    if (request.method === "POST" && uploadMatch) {
      const formData = await request.formData().catch(() => null);
      const photo = formData?.get("photo");
      if (!(photo instanceof File)) {
        return badRequest("请选择要上传的作业照片。");
      }
      const uploaded = await uploadSubmissionPhoto(env, user, uploadMatch[1], photo);
      return uploaded
        ? jsonResponse({ photo: uploaded }, { status: 201 })
        : notFound();
    }

    if (request.method === "POST" && finalizeMatch) {
      const submission = await finalizeSubmission(env, user, finalizeMatch[1]);
      return submission ? jsonResponse({ submission }) : notFound();
    }
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "作业提交失败。");
  }

  return null;
}

function positiveInteger(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
