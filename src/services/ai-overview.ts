import type {
  AiHomeOverviewDto,
  AiOverviewEvidence,
  AiOverviewInsight,
  AuthUser,
  Env,
  TaskDto
} from "../types";
import { localTimestamp } from "../utils";
import { getLearningIssueOverview } from "./ai-learning-issues";
import { listChildren } from "./children";
import { listTasksForUser, todayKey } from "./tasks";

interface TaskMeasure {
  task: TaskDto;
  completed: boolean;
  completionDelayMinutes: number | null;
  claimDelayMinutes: number | null;
}

function shiftDateKey(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function timestampMinutes(value: string | null) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) / 60000);
}

function scheduledMinutes(task: TaskDto) {
  if (!task.occurrenceDate) return null;
  return timestampMinutes(`${task.occurrenceDate} ${task.scheduleTime}:00`);
}

function differenceFromSchedule(task: TaskDto, timestamp: string | null) {
  const scheduled = scheduledMinutes(task);
  const actual = timestampMinutes(timestamp);
  return scheduled === null || actual === null ? null : actual - scheduled;
}

function measureTask(task: TaskDto): TaskMeasure {
  const completed = task.status === "completed" || task.reviewStatus === "completed" || Boolean(task.finalizedAt);
  return {
    task,
    completed,
    completionDelayMinutes: completed ? differenceFromSchedule(task, task.completedAt || task.finalizedAt) : null,
    claimDelayMinutes: differenceFromSchedule(task, task.claimedAt)
  };
}

function percentage(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 100) : 0;
}

function roundedAverage(values: number[]) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function evidence(measure: TaskMeasure, detail: string): AiOverviewEvidence {
  return {
    taskId: measure.task.id,
    childId: measure.task.childId,
    childName: measure.task.childName || "家庭成员",
    taskTitle: measure.task.title,
    occurrenceDate: measure.task.occurrenceDate || "",
    detail
  };
}

function metrics(measures: TaskMeasure[]) {
  const completed = measures.filter((item) => item.completed);
  const completedWithTime = completed.filter((item) => item.completionDelayMinutes !== null);
  const claimed = measures.filter((item) => item.claimDelayMinutes !== null);
  const submitted = measures.filter((item) => item.task.submissionId);
  const revised = submitted.filter((item) => item.task.needsRevision);
  return {
    totalTasks: measures.length,
    completionRate: percentage(completed.length, measures.length),
    onTimeRate: completedWithTime.length
      ? percentage(completedWithTime.filter((item) => (item.completionDelayMinutes || 0) <= 15).length, completedWithTime.length)
      : null,
    averageClaimDelayMinutes: roundedAverage(claimed.map((item) => Math.max(0, item.claimDelayMinutes || 0))),
    revisionRate: submitted.length ? percentage(revised.length, submitted.length) : null
  };
}

function completedStreakDays(measures: TaskMeasure[], to: string) {
  const days = new Map<string, TaskMeasure[]>();
  measures.forEach((measure) => {
    const date = measure.task.occurrenceDate;
    if (!date) return;
    const items = days.get(date) || [];
    items.push(measure);
    days.set(date, items);
  });

  let streak = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const date = shiftDateKey(to, -offset);
    const items = days.get(date);
    if (!items?.length) continue;
    if (!items.every((item) => item.completed)) break;
    streak += 1;
  }
  return streak;
}

function weeklyReport(measures: TaskMeasure[], to: string) {
  const completedTasks = measures.filter((item) => item.completed).length;
  const pendingReviewTasks = measures.filter((item) => item.task.reviewStatus === "pending_review").length;
  const needsRevisionTasks = measures.filter((item) => item.task.reviewStatus === "needs_revision").length;
  const reviewedTasks = measures.filter((item) => Boolean(item.task.reviewedAt)).length;
  const completionRate = percentage(completedTasks, measures.length);
  const averageClaimDelay = roundedAverage(
    measures
      .filter((item) => item.claimDelayMinutes !== null)
      .map((item) => Math.max(0, item.claimDelayMinutes || 0))
  );
  const suggestions: string[] = [];

  if (pendingReviewTasks) suggestions.push(`安排一次集中批改，当前有 ${pendingReviewTasks} 项作业等待家长处理。`);
  if (needsRevisionTasks) suggestions.push(`把 ${needsRevisionTasks} 项待修改任务的完成标准写得更具体，帮助孩子下一次一次完成。`);
  if (completionRate < 70 && measures.length) suggestions.push("下周优先保留最重要的 1—2 项任务，避免任务过多造成拖延。");
  if (averageClaimDelay !== null && averageClaimDelay >= 10) suggestions.push("尝试把提醒提前 15 分钟，并观察下一周的领取节奏。");
  if (!suggestions.length) suggestions.push("当前执行节奏稳定，下周继续保持任务量和提醒时间，再观察一次完整周期。");

  return {
    completedTasks,
    totalTasks: measures.length,
    completionStreakDays: completedStreakDays(measures, to),
    reviewedTasks,
    pendingReviewTasks,
    needsRevisionTasks,
    nextWeekSuggestions: suggestions.slice(0, 3)
  };
}

function buildInsights(measures: TaskMeasure[], completionRate: number, completionRateDelta: number | null) {
  const insights: AiOverviewInsight[] = [];
  const lateClaims = measures
    .filter((item) => (item.claimDelayMinutes || 0) >= 10)
    .sort((left, right) => (right.claimDelayMinutes || 0) - (left.claimDelayMinutes || 0));
  const revised = measures.filter((item) => item.task.needsRevision);

  if (lateClaims.length >= 2) {
    const average = roundedAverage(lateClaims.map((item) => item.claimDelayMinutes || 0)) || 0;
    insights.push({
      id: "late-task-start",
      tone: "attention",
      title: "部分任务开始时间偏晚",
      summary: `${lateClaims.length} 项任务领取时间晚于计划 10 分钟以上，平均延迟 ${average} 分钟。建议一次只调整提醒时间，并观察 7 天。`,
      evidence: lateClaims.slice(0, 4).map((item) => evidence(item, `领取晚于计划 ${Math.max(0, item.claimDelayMinutes || 0)} 分钟`)),
      action: {
        type: "reminder_shift",
        title: "提前 15 分钟提醒",
        description: "仅生成 7 天试行草稿，保存前仍需家长确认。",
        changeMinutes: -15,
        trialDays: 7
      }
    });
  }

  if (revised.length >= 2) {
    insights.push({
      id: "revision-frequency",
      tone: "attention",
      title: "部分任务需要多轮修改",
      summary: `${revised.length} 项任务进入重新提交阶段。可以在创建任务时补充完成标准，或把任务拆成更小步骤。`,
      evidence: revised.slice(0, 4).map((item) => evidence(item, "本次提交已批改，等待重新提交")),
      action: {
        type: "task_breakdown",
        title: "生成任务拆分草稿",
        description: "只生成说明草稿，不会自动修改原任务。",
        trialDays: 7
      }
    });
  }

  if (completionRateDelta !== null && completionRateDelta >= 10) {
    const completed = measures.filter((item) => item.completed).slice(-4);
    insights.push({
      id: "completion-improved",
      tone: "positive",
      title: "任务完成节奏正在改善",
      summary: `本期完成率比上一周期提高 ${completionRateDelta} 个百分点，可以继续保持当前安排。`,
      evidence: completed.map((item) => evidence(item, "任务已完成")),
      action: null
    });
  }

  if (!insights.length && measures.length >= 5) {
    const completed = measures.filter((item) => item.completed).slice(-4);
    insights.push({
      id: "stable-progress",
      tone: completionRate >= 70 ? "positive" : "neutral",
      title: completionRate >= 70 ? "近期任务执行整体稳定" : "继续积累一段时间的数据",
      summary: completionRate >= 70
        ? `本期任务完成率为 ${completionRate}%，暂未发现需要立即调整的明显模式。`
        : "当前数据没有形成稳定模式，建议先保持任务安排，再观察一个周期。",
      evidence: completed.map((item) => evidence(item, "任务已完成")),
      action: null
    });
  }

  return insights.slice(0, 3);
}

export async function getAiHomeOverview(
  env: Env,
  user: AuthUser,
  options: { childId?: string; days: number; from?: string; to?: string }
): Promise<AiHomeOverviewDto> {
  const children = await listChildren(env, user);
  const selectedChild = options.childId
    ? children.find((child) => child.id === options.childId)
    : null;
  if (options.childId && !selectedChild) throw new Error("无权查看该成员的数据。");

  const to = options.to || todayKey(env);
  const from = options.from || shiftDateKey(to, -(options.days - 1));
  const rangeDays = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1;
  if (!Number.isInteger(rangeDays) || rangeDays < 1 || rangeDays > 366) throw new Error("时间范围需为 1 到 366 天。");
  const previousTo = shiftDateKey(from, -1);
  const previousFrom = shiftDateKey(previousTo, -(rangeDays - 1));
  const filters = selectedChild ? { childId: selectedChild.id } : {};
  const [currentTasks, previousTasks, learningIssues] = await Promise.all([
    listTasksForUser(env, user, { ...filters, dateFrom: from, dateTo: to }),
    listTasksForUser(env, user, { ...filters, dateFrom: previousFrom, dateTo: previousTo }),
    getLearningIssueOverview(env, user, { childId: selectedChild?.id, from, to })
  ]);
  const measures = currentTasks.map(measureTask);
  const previousMeasures = previousTasks.map(measureTask);
  const currentMetrics = metrics(measures);
  const previousMetrics = metrics(previousMeasures);
  const completionRateDelta = previousMetrics.totalTasks
    ? currentMetrics.completionRate - previousMetrics.completionRate
    : null;
  const insights = buildInsights(measures, currentMetrics.completionRate, completionRateDelta);
  const dataStatus = measures.length >= 5 ? "ready" : "insufficient";
  const confidence = measures.length >= 14 ? "high" : measures.length >= 7 ? "medium" : "low";
  const lead = insights[0];

  return {
    generatedAt: localTimestamp(),
    analysisMode: "deterministic",
    period: { days: rangeDays, from, to },
    scope: { childId: selectedChild?.id || null, childName: selectedChild?.name || "全部家庭成员" },
    dataStatus,
    confidence,
    summary: dataStatus === "insufficient"
      ? { title: "还需要更多任务数据", description: `当前周期共有 ${measures.length} 项任务，至少积累 5 项后再生成趋势建议。` }
      : {
          title: lead?.title || "近期任务执行整体稳定",
          description: `根据 ${measures.length} 项任务的领取、完成和批改记录生成，所有结论均可查看原始证据。`
        },
    metrics: { ...currentMetrics, completionRateDelta },
    weeklyReport: weeklyReport(measures, to),
    trend: Array.from({ length: rangeDays }, (_, index) => shiftDateKey(from, index)).map((date) => {
      const day = measures.filter((item) => item.task.occurrenceDate === date);
      return { date, total: day.length, completed: day.filter((item) => item.completed).length };
    }),
    insights,
    learningIssues
  };
}
