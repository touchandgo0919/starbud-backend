import { badRequest, jsonResponse, notFound, unauthorized } from "../http";
import { getAuthUser } from "../services/auth";
import {
  createSubmission,
  deleteSubmissionAudio,
  deleteSubmission,
  finalizeSubmissionReview,
  finalizeSubmission,
  getTaskSubmissionForUser,
  getReviewImageObject,
  getReviewRoundImageObject,
  getReviewRoundAudioObject,
  getReviewRoundResultImageObject,
  getReviewRoundPhotoObject,
  getSubmissionAudioObject,
  getSubmissionPhotoObject,
  listNotifications,
  listSubmissions,
  markNotificationRead,
  reopenSubmissionForResubmit,
  submitAudioReview,
  submitReview,
  updateSubmissionNote,
  uploadSubmissionAudio,
  uploadSubmissionPhoto
} from "../services/submissions";
import type { Env } from "../types";

export function audioObjectResponse(object: R2ObjectBody, contentType: string) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "accept-ranges, content-length, content-range",
    "cache-control": "private, max-age=3600",
    "content-type": contentType,
    etag: object.httpEtag
  });

  if (!object.range) {
    headers.set("content-length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }

  const returnedRange = object.range as { offset?: number; length?: number; suffix?: number };
  const rangeOffset = Number(returnedRange.offset);
  const rangeLength = Number(returnedRange.length);
  const rangeSuffix = Number(returnedRange.suffix);
  let offset = 0;
  let length = object.size;

  // R2's returned range object exposes all optional keys at runtime. Checking
  // `"suffix" in range` therefore also matches offset ranges whose suffix is
  // undefined, which previously produced `bytes NaN-NaN/...` and prevented
  // browsers from loading audio metadata.
  if (Number.isFinite(rangeOffset) && Number.isFinite(rangeLength)) {
    offset = Math.max(0, rangeOffset);
    length = Math.min(Math.max(0, rangeLength), Math.max(0, object.size - offset));
  } else if (Number.isFinite(rangeSuffix)) {
    length = Math.min(object.size, Math.max(0, rangeSuffix));
    offset = object.size - length;
  }
  headers.set("content-length", String(length));
  headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
  return new Response(object.body, { status: 206, headers });
}

export async function handleSubmissions(request: Request, env: Env, url: URL) {
  const photoFileMatch = url.pathname.match(/^\/api\/submission-files\/([^/]+)$/);
  const audioFileMatch = url.pathname.match(/^\/api\/submission-audio\/([^/]+)$/);
  const reviewFileMatch = url.pathname.match(/^\/api\/review-files\/([^/]+)$/);
  const reviewRoundFileMatch = url.pathname.match(/^\/api\/review-round-files\/([^/]+)$/);
  const reviewRoundResultImageMatch = url.pathname.match(/^\/api\/review-round-images\/([^/]+)$/);
  const reviewRoundPhotoMatch = url.pathname.match(/^\/api\/review-round-photos\/([^/]+)\/(\d+)$/);
  const reviewRoundAudioMatch = url.pathname.match(/^\/api\/review-round-audios\/([^/]+)\/(\d+)$/);

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

  if (request.method === "GET" && audioFileMatch) {
    const result = await getSubmissionAudioObject(
      env,
      audioFileMatch[1],
      url.searchParams.get("token") || "",
      request.headers
    );
    if (!result) return notFound();
    return audioObjectResponse(result.object, result.audio.content_type);
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

  if (request.method === "GET" && reviewRoundFileMatch) {
    const result = await getReviewRoundImageObject(env, reviewRoundFileMatch[1], url.searchParams.get("token") || "");
    if (!result) return notFound();
    return new Response(result.object.body, { headers: { "access-control-allow-origin": "*", "cache-control": "private, max-age=3600", "content-type": result.contentType, etag: result.object.httpEtag } });
  }

  if (request.method === "GET" && reviewRoundResultImageMatch) {
    const result = await getReviewRoundResultImageObject(env, reviewRoundResultImageMatch[1], url.searchParams.get("token") || "");
    if (!result) return notFound();
    return new Response(result.object.body, { headers: { "access-control-allow-origin": "*", "cache-control": "private, max-age=3600", "content-type": result.contentType, etag: result.object.httpEtag } });
  }

  if (request.method === "GET" && reviewRoundPhotoMatch) {
    const result = await getReviewRoundPhotoObject(env, reviewRoundPhotoMatch[1], Number(reviewRoundPhotoMatch[2]), url.searchParams.get("token") || "");
    if (!result) return notFound();
    return new Response(result.object.body, { headers: { "access-control-allow-origin": "*", "cache-control": "private, max-age=3600", "content-type": result.contentType, etag: result.object.httpEtag } });
  }

  if (request.method === "GET" && reviewRoundAudioMatch) {
    const result = await getReviewRoundAudioObject(
      env,
      reviewRoundAudioMatch[1],
      Number(reviewRoundAudioMatch[2]),
      url.searchParams.get("token") || "",
      request.headers
    );
    if (!result) return notFound();
    return audioObjectResponse(result.object, result.contentType);
  }

  const createMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/submissions$/);
  const taskSubmissionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/submission$/);
  const uploadMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/photos$/);
  const audioUploadMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/audio$/);
  const finalizeMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/submit$/);
  const reviewMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/review$/);
  const audioReviewMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/audio-review$/);
  const resubmitMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/resubmit$/);
  const finalizeReviewMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/finalize-review$/);
  const deleteSubmissionMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)$/);
  const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  const handlesPath = url.pathname === "/api/submissions"
    || url.pathname === "/api/notifications"
    || Boolean(createMatch)
    || Boolean(taskSubmissionMatch)
    || Boolean(uploadMatch)
    || Boolean(audioUploadMatch)
    || Boolean(finalizeMatch)
    || Boolean(reviewMatch)
    || Boolean(audioReviewMatch)
    || Boolean(resubmitMatch)
    || Boolean(finalizeReviewMatch)
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
        childId: url.searchParams.get("childId") || undefined,
        status: (url.searchParams.get("status") === "draft" || url.searchParams.get("status") === "submitted")
          ? url.searchParams.get("status") as "draft" | "submitted"
          : undefined,
        reviewStatus: (["pending", "reviewed", "completed"] as const).includes(url.searchParams.get("reviewStatus") as "pending" | "reviewed" | "completed")
          ? url.searchParams.get("reviewStatus") as "pending" | "reviewed" | "completed"
          : undefined,
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
      const input = (await request.json().catch(() => null)) as { note?: string; taskDate?: string } | null;
      if (!input) {
        return badRequest("Invalid JSON body.");
      }
      const submission = await createSubmission(env, user, createMatch[1], input.note, input.taskDate);
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

    if (request.method === "POST" && audioUploadMatch) {
      const formData = await request.formData().catch(() => null);
      const audio = formData?.get("audio");
      const durationMs = Number(formData?.get("durationMs"));
      if (!(audio instanceof File)) return badRequest("请选择要上传的录音。");
      const uploaded = await uploadSubmissionAudio(env, user, audioUploadMatch[1], audio, durationMs);
      return uploaded ? jsonResponse({ audio: uploaded }, { status: 201 }) : notFound();
    }

    if (request.method === "DELETE" && audioUploadMatch) {
      const deleted = await deleteSubmissionAudio(env, user, audioUploadMatch[1]);
      return deleted ? jsonResponse({ deleted: true }) : notFound();
    }

    if (request.method === "POST" && finalizeMatch) {
      const submission = await finalizeSubmission(env, user, finalizeMatch[1]);
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "POST" && reviewMatch) {
      const formData = await request.formData().catch(() => null);
      const images = formData
        ? [...formData.getAll("images"), formData.get("image")]
          .filter((image): image is File => image instanceof File)
        : [];
      if (!images.length) {
        return badRequest("请上传批改后的图片。");
      }
      const replaceReviewImageId = formData?.get("replaceReviewImageId");
      const submission = await submitReview(
        env,
        user,
        reviewMatch[1],
        images,
        typeof replaceReviewImageId === "string" && replaceReviewImageId ? replaceReviewImageId : null
      );
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "POST" && audioReviewMatch) {
      const input = (await request.json().catch(() => null)) as { feedback?: unknown } | null;
      if (!input || typeof input.feedback !== "string") return badRequest("请填写录音评价。");
      const submission = await submitAudioReview(env, user, audioReviewMatch[1], input.feedback);
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "POST" && resubmitMatch) {
      const submission = await reopenSubmissionForResubmit(env, user, resubmitMatch[1]);
      return submission ? jsonResponse({ submission }) : notFound();
    }

    if (request.method === "POST" && finalizeReviewMatch) {
      const submission = await finalizeSubmissionReview(env, user, finalizeReviewMatch[1]);
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
