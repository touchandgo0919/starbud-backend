import { badRequest, jsonResponse, notFound, unauthorized } from "../http";
import { getAuthUser } from "../services/auth";
import {
  createSubmission,
  deleteSubmission,
  finalizeSubmission,
  getTaskSubmissionForUser,
  getReviewImageObject,
  getSubmissionPhotoObject,
  listNotifications,
  listSubmissions,
  markNotificationRead,
  reopenSubmissionForResubmit,
  submitReview,
  updateSubmissionNote,
  uploadSubmissionPhoto
} from "../services/submissions";
import type { Env } from "../types";

export async function handleSubmissions(request: Request, env: Env, url: URL) {
  const photoFileMatch = url.pathname.match(/^\/api\/submission-files\/([^/]+)$/);
  const reviewFileMatch = url.pathname.match(/^\/api\/review-files\/([^/]+)$/);

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

  if (request.method === "GET" && reviewFileMatch) {
    const accessToken = url.searchParams.get("token") || "";
    const result = await getReviewImageObject(env, reviewFileMatch[1], accessToken);
    if (!result) {
      return notFound();
    }

    return new Response(result.object.body, {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "private, max-age=3600",
        "content-type": result.contentType,
        etag: result.object.httpEtag
      }
    });
  }

  const createMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/submissions$/);
  const taskSubmissionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/submission$/);
  const uploadMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/photos$/);
  const finalizeMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/submit$/);
  const reviewMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/review$/);
  const resubmitMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/resubmit$/);
  const deleteSubmissionMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)$/);
  const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  const handlesPath = url.pathname === "/api/submissions"
    || url.pathname === "/api/notifications"
    || Boolean(createMatch)
    || Boolean(taskSubmissionMatch)
    || Boolean(uploadMatch)
    || Boolean(finalizeMatch)
    || Boolean(reviewMatch)
    || Boolean(resubmitMatch)
    || Boolean(deleteSubmissionMatch)
    || Boolean(notificationReadMatch);

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

    if (request.method === "GET" && taskSubmissionMatch) {
      const date = url.searchParams.get("date") || "";
      if (!date) return badRequest("缺少任务日期。");
      const submission = await getTaskSubmissionForUser(env, user, taskSubmissionMatch[1], date);
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "GET" && url.pathname === "/api/notifications") {
      return jsonResponse({ notifications: await listNotifications(env, user) });
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

    if (request.method === "POST" && reviewMatch) {
      const formData = await request.formData().catch(() => null);
      const image = formData?.get("image");
      if (!(image instanceof File)) {
        return badRequest("请上传批改后的图片。");
      }
      const submission = await submitReview(env, user, reviewMatch[1], image);
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "POST" && resubmitMatch) {
      const submission = await reopenSubmissionForResubmit(env, user, resubmitMatch[1]);
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "DELETE" && deleteSubmissionMatch) {
      const deleted = await deleteSubmission(env, user, deleteSubmissionMatch[1]);
      return deleted ? jsonResponse({ deleted: true }) : notFound();
    }

    if (request.method === "PATCH" && deleteSubmissionMatch) {
      const input = (await request.json().catch(() => null)) as { note?: string } | null;
      if (!input || typeof input.note !== "string") return badRequest("请填写提交备注。");
      const submission = await updateSubmissionNote(env, user, deleteSubmissionMatch[1], input.note);
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "POST" && notificationReadMatch) {
      const updated = await markNotificationRead(env, user, notificationReadMatch[1]);
      return updated ? jsonResponse({ ok: true }) : notFound();
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
