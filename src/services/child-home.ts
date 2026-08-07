import type { AuthUser, ChildHomeAttentionDto, ChildHomeDto, Env, TaskDto } from "../types";
import { localTimestamp } from "../utils";
import { getChildNextStep } from "./ai-analysis";
import { getTodayTasksForUser, todayKey } from "./tasks";

interface AttentionRow {
  notification_id: string;
  title: string;
  content: string;
  task_id: string;
  task_date: string;
}

function isCompleted(task: TaskDto) {
  return task.status === "completed" || task.reviewStatus === "completed" || Boolean(task.finalizedAt);
}

function greetingForTimestamp(timestamp: string) {
  const hour = Number(timestamp.slice(11, 13));
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function encouragementFor(tasks: TaskDto[], completed: number) {
  if (!tasks.length) {
    return { title: "今天可以轻松一点", description: "暂时没有新任务，可以整理书桌或读一会儿书。", source: "facts" as const };
  }
  if (completed === tasks.length) {
    return { title: "今天的任务都完成了", description: `你已经完成 ${completed} 项任务，可以回顾一下最顺利的一步。`, source: "facts" as const };
  }
  if (completed > 0) {
    return { title: "已经有进展了", description: `今天已经完成 ${completed} 项，还剩 ${tasks.length - completed} 项，继续按自己的节奏来。`, source: "facts" as const };
  }
  return { title: "从一件小事开始", description: `今天有 ${tasks.length} 项任务，先完成首页推荐的这一项。`, source: "facts" as const };
}

async function listAttention(env: Env, user: AuthUser, excludedTaskId: string | null) {
  const result = await env.DB.prepare(
    `SELECT
       notifications.id AS notification_id,
       notifications.title,
       notifications.content,
       task_submissions.task_id,
       task_submissions.task_date
     FROM notifications
     INNER JOIN task_submissions ON task_submissions.id = notifications.submission_id
     WHERE notifications.recipient_user_id = ?
       AND notifications.type = 'review_completed'
       AND notifications.read_at IS NULL
     ORDER BY notifications.created_at DESC
     LIMIT 5`
  ).bind(user.id).all<AttentionRow>();

  return result.results
    .filter((row) => row.task_id !== excludedTaskId)
    .slice(0, 1)
    .map<ChildHomeAttentionDto>((row) => ({
      notificationId: row.notification_id,
      title: row.title,
      description: row.content,
      taskId: row.task_id,
      taskDate: row.task_date,
      actionLabel: "查看批改"
    }));
}

export async function getChildHome(env: Env, user: AuthUser): Promise<ChildHomeDto> {
  const tasks = await getTodayTasksForUser(env, user);
  const nextStep = await getChildNextStep(env, user, tasks);
  const completed = tasks.filter(isCompleted).length;
  const timestamp = localTimestamp();
  const attention = await listAttention(env, user, nextStep.taskId);

  return {
    date: todayKey(env),
    greeting: greetingForTimestamp(timestamp),
    progress: {
      total: tasks.length,
      completed,
      pending: Math.max(0, tasks.length - completed),
      percent: tasks.length ? Math.round((completed / tasks.length) * 100) : 0
    },
    attention,
    nextStep,
    encouragement: encouragementFor(tasks, completed),
    syncedAt: timestamp
  };
}
