import assert from "node:assert/strict";
import { File } from "node:buffer";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import undici from "undici";

const { FormData } = undici;

const jwtSecret = "starbud-test-secret-with-at-least-32-characters";
const passwordSuffix = "@test";
const adminPassword = "admin-test-password";
const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(backendDir, "..", "migrations");
const baseUrl = "http://starbud.test";
let stateDir;
let runtime;

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      current += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (!quote && character === "-" && next === "-") {
      lineComment = true;
      current += character;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      if (quote === character && next === character) {
        current += character + next;
        index += 1;
        continue;
      }
      quote = quote ? null : character;
    }
    if (!quote && character === ";") {
      if (current.replace(/^\s*--.*$/gm, "").trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.replace(/^\s*--.*$/gm, "").trim()) statements.push(current.trim());
  return statements;
}

function addedColumn(statement) {
  const normalized = statement
    .replace(/^\s*--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^ALTER\s+TABLE\s+[`"[]?([\w]+)[`"\]]?\s+ADD\s+COLUMN\s+[`"[]?([\w]+)[`"\]]?/i.exec(normalized);
  return match ? { table: match[1], column: match[2] } : null;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("x-starbud-client", options.client || "test_suite");
  headers.set("x-starbud-session-id", options.sessionId || "integration-session");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const requestInit = {
    method: options.method || "GET",
    headers,
    body: options.body instanceof FormData
      ? options.body
      : options.body === undefined ? undefined : JSON.stringify(options.body)
  };
  const response = await runtime.dispatchFetch(`${baseUrl}${path}`, requestInit);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : new Uint8Array(await response.arrayBuffer());
  if (options.status !== undefined) {
    assert.equal(response.status, options.status, JSON.stringify(body));
  } else {
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  }
  return { response, body };
}

async function login(username, password, client) {
  const { body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password },
    client
  });
  return body;
}

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "starbud-api-test-"));
  const bundlePath = join(stateDir, "worker.mjs");
  await build({
    entryPoints: [resolve(backendDir, "src/index.ts")],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "browser",
    target: "es2022"
  });
  runtime = new Miniflare({
    modules: true,
    script: await readFile(bundlePath, "utf8"),
    compatibilityDate: "2026-07-21",
    d1Databases: ["DB"],
    r2Buckets: ["SUBMISSION_FILES"],
    durableObjects: {
      USER_REALTIME: { className: "UserRealtime", useSQLite: true }
    },
    bindings: {
      JWT_SECRET: jwtSecret,
      ADMIN_INITIAL_PASSWORD: adminPassword,
      INITIAL_PASSWORD_SUFFIX: passwordSuffix,
      SEED_DEMO_USERS: "true",
      APP_TIME_ZONE: "Asia/Shanghai"
    }
  });
  const database = await runtime.getD1Database("DB");
  const migrations = (await readdir(migrationsDir))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDir, migration), "utf8");
    for (const statement of splitSqlStatements(sql)) {
      const addition = addedColumn(statement);
      if (addition) {
        const columns = await database.prepare(`PRAGMA table_info('${addition.table}')`).all();
        if (columns.results.some((column) => column.name === addition.column)) continue;
      }
      await database.prepare(statement).run();
    }
  }
});

after(async () => {
  await runtime?.dispose();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

describe("Starbud Worker API", () => {
  test("reports health, CORS policy, validation and authentication failures", async () => {
    const health = await api("/health", { status: 200 });
    assert.equal(health.body.ok, true);
    assert.equal(health.body.checks.authentication, "ready");
    assert.equal(health.body.checks.ai, "not_configured");
    assert.equal(health.body.ai.model, "gpt-5.5");
    assert.equal(health.body.ai.reasoningEffort, "xhigh");
    assert.equal(health.body.ai.responseStorageEnabled, false);

    const preflight = await runtime.dispatchFetch(`${baseUrl}/api/tasks`, {
      method: "OPTIONS",
      headers: { "access-control-request-headers": "Content-Type,X-Starbud-Client,X-Starbud-Session-Id,X-Unsafe" }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /x-starbud-session-id/);
    assert.doesNotMatch(preflight.headers.get("access-control-allow-headers"), /x-unsafe/);

    await api("/api/me", { status: 401 });
    await api("/api/auth/login", { method: "POST", body: {}, status: 400 });
    await api("/api/auth/login", {
      method: "POST",
      body: { username: "admin", password: "wrong-password" },
      status: 401
    });
    await api("/missing", { status: 404 });
  });

  test("covers family, task, mini-program submission, review and audit workflows", async () => {
    const parent = await login("zhaotao", `zhaotao${passwordSuffix}`, "web");
    const child = await login("zhaoyouning", `zhaoyouning${passwordSuffix}`, "mini_program");
    const admin = await login("admin", adminPassword, "web");
    assert.equal(parent.user.role, "parent");
    assert.equal(child.user.role, "child");
    assert.equal(admin.user.role, "admin");

    const realtimeResponse = await runtime.dispatchFetch(`${baseUrl}/api/realtime`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `starbud-realtime, token.${child.token}`
      }
    });
    assert.equal(realtimeResponse.status, 101);
    assert.equal(realtimeResponse.headers.get("sec-websocket-protocol"), "starbud-realtime");
    const realtimeSocket = realtimeResponse.webSocket;
    assert.ok(realtimeSocket);
    realtimeSocket.accept();
    const connectedSignal = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Realtime connection timed out")), 1000);
      realtimeSocket.addEventListener("message", (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)));
      }, { once: true });
    });
    assert.equal(connectedSignal.type, "connected");
    realtimeSocket.close(1000, "test-complete");

    const me = await api("/api/me", { token: parent.token, client: "web" });
    assert.equal(me.body.user.username, "zhaotao");
    const children = await api("/api/children", { token: parent.token, client: "web" });
    const targetChild = children.body.children.find((item) => item.name === "赵佑宁");
    assert.ok(targetChild);

    await api("/api/tasks", {
      method: "POST",
      token: child.token,
      client: "desktop_app",
      body: { childId: targetChild.id, title: "forbidden", scheduleTime: "18:00", repeatType: "once" },
      status: 403
    });

    const familyCreated = await api("/api/families", {
      method: "POST", token: parent.token, client: "web", body: { name: "自动化测试家庭" }, status: 201
    });
    const familyId = familyCreated.body.family.id;
    const familyRenamed = await api(`/api/families/${familyId}`, {
      method: "PATCH", token: parent.token, client: "web", body: { name: "自动化测试家庭-已更新" }
    });
    assert.equal(familyRenamed.body.family.name, "自动化测试家庭-已更新");

    const memberAdded = await api(`/api/families/${familyId}/members`, {
      method: "POST", token: parent.token, client: "web",
      body: { username: "wangyamei", relationship: "共同监护人" }
    });
    const addedMember = memberAdded.body.family.members.find((item) => item.username === "wangyamei");
    assert.ok(addedMember);
    const memberUpdated = await api(`/api/families/${familyId}/members/${addedMember.id}`, {
      method: "PATCH", token: parent.token, client: "web", body: { relationship: "妈妈" }
    });
    assert.equal(memberUpdated.body.family.members.find((item) => item.id === addedMember.id).relationship, "妈妈");

    const childUsername = `api-child-${Date.now()}`;
    const childCreated = await api(`/api/families/${familyId}/children`, {
      method: "POST", token: parent.token, client: "web",
      body: { username: childUsername, displayName: "接口测试孩子", password: "child-test-123", relationship: "孩子" }
    });
    assert.ok(childCreated.body.family.members.some((item) => item.username === childUsername));

    const date = localDateKey();
    const taskCreated = await api("/api/tasks", {
      method: "POST", token: parent.token, client: "web", status: 201,
      body: {
        childId: targetChild.id,
        title: `端到端作业 ${Date.now()}`,
        scheduleTime: "23:59",
        repeatType: "once",
        voiceEnabled: true,
        voiceContent: "完成自动化测试任务",
        voiceReminderCount: 2,
        claimReminderEnabled: true,
        revisionReminderEnabled: true,
        requiresPhotoUpload: true,
        startDate: date
      }
    });
    const taskId = taskCreated.body.task.id;

    await api(`/api/tasks/${taskId}/remind`, {
      method: "POST", token: parent.token, client: "mini_program",
      body: { taskDate: date, reminderType: "claim" }
    });
    const claimNotifications = await api("/api/notifications", {
      token: child.token, client: "mini_program"
    });
    assert.ok(claimNotifications.body.notifications.some((item) => item.type === "claim_reminder" && item.content.includes(taskCreated.body.task.title)));

    await api(`/api/ai/home-overview?childId=${targetChild.id}&days=7`, {
      token: child.token, client: "mini_program", status: 403
    });

    await api("/api/ai/child-next-step", {
      token: parent.token, client: "web", status: 403
    });
    await api("/api/child/home", {
      token: parent.token, client: "web", status: 403
    });
    const childNextStep = await api("/api/ai/child-next-step", {
      token: child.token, client: "mini_program"
    });
    assert.equal(childNextStep.body.nextStep.taskId, taskId);
    assert.equal(childNextStep.body.nextStep.stage, "claim");
    assert.equal(childNextStep.body.nextStep.source, "rules");

    const childHome = await api("/api/child/home", {
      token: child.token, client: "mini_program"
    });
    assert.equal(childHome.body.home.nextStep.taskId, taskId);
    assert.equal(childHome.body.home.progress.total >= 1, true);
    assert.equal(childHome.body.home.progress.pending >= 1, true);
    assert.equal(childHome.body.home.encouragement.source, "facts");
    assert.ok(Array.isArray(childHome.body.home.attention));

    const taskList = await api(`/api/tasks?page=1&pageSize=10&date=${date}`, {
      token: child.token, client: "mini_program"
    });
    assert.ok(taskList.body.tasks.some((item) => item.id === taskId));
    assert.equal(taskList.body.pagination.page, 1);

    const taskListWithAttachments = await api(`/api/tasks?page=1&pageSize=10&date=${date}&includeAttachments=true`, {
      token: child.token, client: "web"
    });
    assert.ok(taskListWithAttachments.body.tasks.every((item) => "attachmentPhotoCount" in item));

    const calendar = await api(`/api/tasks/calendar?dateFrom=${date}&dateTo=${date}`, {
      token: child.token, client: "mini_program"
    });
    assert.equal(calendar.body.dates[date], "pending");

    const claimed = await api(`/api/tasks/${taskId}/claim`, {
      method: "POST", token: child.token, client: "desktop_app", body: { taskDate: date }
    });
    assert.ok(claimed.body.task.claimedAt);

    await api(`/api/tasks/${taskId}/remind`, {
      method: "POST", token: parent.token, client: "mini_program",
      body: { taskDate: date, reminderType: "complete" }
    });
    const completionNotifications = await api("/api/notifications", {
      token: child.token, client: "mini_program"
    });
    assert.ok(completionNotifications.body.notifications.some((item) => item.type === "voice_reminder" && item.content.includes(taskCreated.body.task.title)));

    const database = await runtime.getD1Database("DB");
    await database.prepare(
      `INSERT INTO ai_analysis_results (
        id, child_id, analysis_date, period_days, status, model,
        result_json, generated_at, updated_at
       ) VALUES (?, ?, ?, 28, 'completed', 'gpt-5.5', ?, ?, ?)`
    ).bind(
      `analysis-${Date.now()}`,
      targetChild.id,
      date,
      JSON.stringify({
        parentSummary: { title: "任务开始更稳定", description: "近期任务领取节奏趋于稳定。" },
        childNextStep: { title: "完成眼前的一步", description: "先完成当前任务，完成后检查附件再提交。" }
      }),
      `${date} 04:00:00`,
      `${date} 04:00:00`
    ).run();

    const claimedNextStep = await api("/api/ai/child-next-step", {
      token: child.token, client: "mini_program"
    });
    assert.equal(claimedNextStep.body.nextStep.taskId, taskId);
    assert.equal(claimedNextStep.body.nextStep.stage, "continue");
    assert.equal(claimedNextStep.body.nextStep.source, "model");
    assert.match(claimedNextStep.body.nextStep.description, /检查附件/);

    const createdSubmission = await api(`/api/tasks/${taskId}/submissions`, {
      method: "POST", token: child.token, client: "mini_program", status: 201,
      body: { note: "小程序自动化提交", taskDate: date }
    });
    const submissionId = createdSubmission.body.submission.id;
    const invalidUpload = new FormData();
    invalidUpload.append("photo", new File(["bad"], "bad.txt", { type: "text/plain" }));
    await api(`/api/submissions/${submissionId}/photos`, {
      method: "POST", token: child.token, client: "mini_program", body: invalidUpload, status: 400
    });

    const photoData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const photoUpload = new FormData();
    photoUpload.append("photo", new File([photoData], "homework.png", { type: "image/png" }));
    const uploaded = await api(`/api/submissions/${submissionId}/photos`, {
      method: "POST", token: child.token, client: "mini_program", body: photoUpload, status: 201
    });
    assert.equal(uploaded.body.photo.contentType, "image/png");

    const audioUpload = new FormData();
    audioUpload.append("audio", new File([new Uint8Array([1, 2, 3, 4])], "answer.mp3", { type: "audio/mpeg" }));
    audioUpload.append("durationMs", "1500");
    const audio = await api(`/api/submissions/${submissionId}/audio`, {
      method: "POST", token: child.token, client: "mini_program", body: audioUpload, status: 201
    });
    assert.equal(audio.body.audio.durationMs, 1500);

    const noteUpdated = await api(`/api/submissions/${submissionId}`, {
      method: "PATCH", token: child.token, client: "mini_program", body: { note: "补充说明已更新" }
    });
    assert.equal(noteUpdated.body.submission.note, "补充说明已更新");
    const submitted = await api(`/api/submissions/${submissionId}/submit`, {
      method: "POST", token: child.token, client: "mini_program"
    });
    assert.equal(submitted.body.submission.status, "submitted");

    const submissions = await api("/api/submissions?page=1&pageSize=10&status=submitted", {
      token: parent.token, client: "web"
    });
    assert.ok(submissions.body.submissions.some((item) => item.id === submissionId));
    const listSubmission = submissions.body.submissions.find((item) => item.id === submissionId);
    assert.equal(listSubmission.photos.length, 1);
    assert.ok(listSubmission.audio);
    assert.deepEqual(listSubmission.reviewRounds, []);

    const todaySubmissions = await api(`/api/submissions?page=1&pageSize=10&date=${date}`, {
      token: parent.token, client: "web"
    });
    assert.ok(todaySubmissions.body.submissions.some((item) => item.id === submissionId));

    const noteSearch = await api(`/api/submissions?page=1&pageSize=10&keyword=${encodeURIComponent("补充说明已更新")}`, {
      token: parent.token, client: "web"
    });
    assert.ok(noteSearch.body.submissions.some((item) => item.id === submissionId));

    const reviewUpload = new FormData();
    reviewUpload.append("images", new File([photoData], "review.png", { type: "image/png" }));
    const reviewed = await api(`/api/submissions/${submissionId}/review`, {
      method: "POST", token: parent.token, client: "web", body: reviewUpload
    });
    assert.ok(reviewed.body.submission.reviewImageUrl);
    await api(`/api/tasks/${taskId}/remind`, {
      method: "POST", token: parent.token, client: "mini_program",
      body: { taskDate: date, reminderType: "revision" }
    });
    const revisionNotifications = await api("/api/notifications", {
      token: child.token, client: "mini_program"
    });
    assert.ok(revisionNotifications.body.notifications.some((item) => item.type === "revision_reminder" && item.content.includes(taskCreated.body.task.title)));
    const revisionReminder = await (await runtime.getD1Database("DB")).prepare(
      "SELECT reminder_count FROM task_revision_reminders WHERE task_id = ? AND task_date = ?"
    ).bind(taskId, date).first();
    assert.equal(revisionReminder?.reminder_count, 0);
    const feedback = await api(`/api/submissions/${submissionId}/audio-review`, {
      method: "POST", token: parent.token, client: "web", body: { feedback: "完成得很好" }
    });
    assert.equal(feedback.body.submission.audioFeedback, "完成得很好");
    const finalized = await api(`/api/submissions/${submissionId}/finalize-review`, {
      method: "POST", token: parent.token, client: "web"
    });
    assert.ok(finalized.body.submission.finalizedAt);

    const aiOverview = await api(`/api/ai/home-overview?childId=${targetChild.id}&days=7`, {
      token: parent.token, client: "web"
    });
    assert.equal(aiOverview.body.overview.scope.childId, targetChild.id);
    assert.equal(aiOverview.body.overview.period.days, 7);
    assert.ok(aiOverview.body.overview.metrics.totalTasks >= 1);
    assert.ok(aiOverview.body.overview.metrics.completionRate >= 0);
    assert.equal(aiOverview.body.overview.trend.length, 7);
    assert.equal(aiOverview.body.overview.analysisMode, "deterministic");
    assert.equal(aiOverview.body.overview.modelAnalysis, null);
    assert.equal(aiOverview.body.overview.learningIssues.status, "analyzing");
    assert.equal(aiOverview.body.overview.learningIssues.analyzingReviews, 2);
    assert.equal(aiOverview.body.overview.learningIssues.issueCount, 0);
    const issueDatabase = await runtime.getD1Database("DB");
    const pendingIssueAnalyses = await issueDatabase.prepare(
      "SELECT id FROM ai_learning_issue_analyses WHERE child_id = ? ORDER BY reviewed_at ASC"
    ).bind(targetChild.id).all();
    assert.equal(pendingIssueAnalyses.results.length, 2);
    for (const analysis of pendingIssueAnalyses.results) {
      await issueDatabase.prepare(
        `UPDATE ai_learning_issue_analyses
         SET status = 'completed', model = 'gpt-5.5', result_json = ?, generated_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(JSON.stringify({
        summary: "需要继续巩固进位计算。",
        issues: [
          { topic: "进位加法", category: "calculation", summary: "进位步骤遗漏", evidence: "家长批改记录", confidence: "high" },
          { topic: "疑似审题", category: "comprehension", summary: "证据不足", evidence: "未明确标注", confidence: "low" }
        ]
      }), "2026-08-08 12:00:00", "2026-08-08 12:00:00", analysis.id).run();
    }
    const summarizedIssues = await api(`/api/ai/home-overview?childId=${targetChild.id}&days=7`, {
      token: parent.token, client: "web"
    });
    assert.equal(summarizedIssues.body.overview.learningIssues.status, "ready");
    assert.equal(summarizedIssues.body.overview.learningIssues.issueCount, 2);
    assert.equal(summarizedIssues.body.overview.learningIssues.recurring[0].topic, "进位加法");
    assert.equal(summarizedIssues.body.overview.learningIssues.recurring[0].count, 2);
    assert.ok(summarizedIssues.body.overview.learningIssues.recent.every((item) => item.topic !== "疑似审题"));
    assert.ok(summarizedIssues.body.overview.learningIssues.recent.every((item) => item.resolved));
    const monthlyAiOverview = await api(`/api/ai/home-overview?childId=${targetChild.id}&days=28`, {
      token: parent.token, client: "web"
    });
    assert.equal(monthlyAiOverview.body.overview.modelAnalysis.model, "gpt-5.5");
    assert.equal(monthlyAiOverview.body.overview.modelAnalysis.result.parentSummary.title, "任务开始更稳定");

    const childSubmission = await api(`/api/tasks/${taskId}/submission?date=${date}`, {
      token: child.token, client: "mini_program"
    });
    assert.ok(childSubmission.body.submission.reviewRounds.length >= 1);
    assert.ok(childSubmission.body.submission.reviewRounds.some((round) => round.reviewImages.length > 0));
    assert.equal(childSubmission.body.submission.audioFeedback, "完成得很好");
    const signedFile = await runtime.dispatchFetch(`${baseUrl}${childSubmission.body.submission.photos[0].url}`);
    assert.equal(signedFile.status, 200);
    assert.equal(signedFile.headers.get("content-type"), "image/png");
    await api(childSubmission.body.submission.photos[0].url.replace(/token=[^&]+/, "token=invalid"), { status: 404 });

    const notifications = await api("/api/notifications", { token: child.token, client: "desktop_app" });
    const completionNotice = notifications.body.notifications.find((item) => !item.readAt);
    assert.ok(completionNotice);
    const firstNotificationRead = await api(`/api/notifications/${completionNotice.id}/read`, {
      method: "POST", token: child.token, client: "desktop_app"
    });
    assert.equal(firstNotificationRead.body.ok, true);
    const duplicateNotificationRead = await api(`/api/notifications/${completionNotice.id}/read`, {
      method: "POST", token: child.token, client: "desktop_app"
    });
    assert.equal(duplicateNotificationRead.body.ok, false);

    const reopened = await api(`/api/submissions/${submissionId}/resubmit`, {
      method: "POST", token: child.token, client: "mini_program"
    });
    assert.equal(reopened.body.submission.status, "draft");
    const resubmissionPhoto = new FormData();
    resubmissionPhoto.append("photo", new File([photoData], "homework-again.png", { type: "image/png" }));
    await api(`/api/submissions/${submissionId}/photos`, {
      method: "POST", token: child.token, client: "mini_program", body: resubmissionPhoto, status: 201
    });
    await api(`/api/submissions/${submissionId}/submit`, {
      method: "POST", token: child.token, client: "mini_program"
    });
    const completedTaskAwaitingReview = await api(`/api/tasks?date=${date}`, {
      token: parent.token, client: "web"
    });
    const resubmittedTask = completedTaskAwaitingReview.body.tasks.find((item) => item.id === taskId);
    assert.equal(resubmittedTask.status, "completed");
    assert.equal(resubmittedTask.reviewStatus, "pending_review");
    assert.ok(resubmittedTask.completedAt);

    await api("/api/admin/users", { token: parent.token, client: "web", status: 403 });
    const users = await api("/api/admin/users", { token: admin.token, client: "web" });
    assert.ok(users.body.users.some((item) => item.username === childUsername));
    const events = await api("/api/access-events?page=1&pageSize=100", { token: admin.token, client: "web" });
    assert.ok(events.body.events.some((item) => item.clientType === "mini_program"));
    assert.ok(events.body.events.some((item) => item.clientType === "desktop_app"));

    await api(`/api/families/${familyId}/members/${addedMember.id}`, {
      method: "DELETE", token: parent.token, client: "web"
    });
    await api(`/api/families/${familyId}`, {
      method: "DELETE", token: parent.token, client: "web"
    });
    await api(`/api/tasks/${taskId}`, { method: "DELETE", token: parent.token, client: "web" });
  });
});
