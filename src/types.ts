export interface Env {
  APP_TIME_ZONE?: string;
  DB: D1Database;
  SUBMISSION_FILES: R2Bucket;
  OPENAI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_PROVIDER?: string;
  AI_REASONING_EFFORT?: string;
  AI_RESPONSES_PATH?: string;
  AI_ANALYSIS_HOUR?: string;
  ADMIN_INITIAL_PASSWORD?: string;
  INITIAL_PASSWORD_SUFFIX?: string;
  JWT_SECRET?: string;
  SEED_DEMO_USERS?: string;
}

export type RepeatType = "once" | "daily" | "weekdays" | "weekly";

export type TaskReviewStatus = "not_required" | "pending_submission" | "submitting" | "pending_review" | "needs_revision" | "completed";

export type UserRole = "admin" | "parent" | "child";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  active: number;
  created_at: string;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface AdminUserDto extends AuthUser {
  active: boolean;
  createdAt: string;
}

export interface SaveUserInput {
  username?: string;
  displayName?: string;
  role?: UserRole;
  active?: boolean;
  password?: string;
}

export interface RegisterParentInput {
  username?: string;
  displayName?: string;
  password?: string;
}

export interface CreateChildInput {
  username?: string;
  displayName?: string;
  password?: string;
  relationship?: string;
}

export interface ChildDto {
  id: string;
  name: string;
  deviceId: string | null;
}

export interface FamilyRow {
  id: string;
  name: string;
  created_by: string;
  is_default: number;
  created_at: string;
}

export interface FamilyMemberDto {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  relationship: string;
  isOwner: boolean;
}

export interface FamilyDto {
  id: string;
  name: string;
  isOwner: boolean;
  canManage: boolean;
  canDelete: boolean;
  members: FamilyMemberDto[];
  createdAt: string;
}

export interface TaskRow {
  id: string;
  child_id: string;
  title: string;
  schedule_time: string;
  repeat_type: RepeatType;
  voice_enable: number;
  voice_content: string | null;
  voice_reminder_count: number;
  claim_reminder_enabled: number;
  require_photo_upload: number;
  active: number;
  start_date: string | null;
  created_at: string;
  record_status: string | null;
  record_date: string | null;
  completed_at: string | null;
  claimed_at: string | null;
  submission_id: string | null;
  submission_status: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  finalized_at: string | null;
  submission_photo_count: number | null;
}

export interface TaskDto {
  id: string;
  childId: string;
  childName?: string;
  title: string;
  scheduleTime: string;
  repeatType: RepeatType;
  voiceEnabled: boolean;
  voiceContent: string;
  voiceReminderCount: number;
  claimReminderEnabled: boolean;
  requiresPhotoUpload: boolean;
  status: "pending" | "completed" | "missed";
  occurrenceDate: string | null;
  completedAt: string | null;
  claimedAt: string | null;
  submissionId: string | null;
  submissionStatus: "draft" | "submitted" | null;
  reviewedAt: string | null;
  finalizedAt: string | null;
  needsRevision: boolean;
  reviewStatus: TaskReviewStatus;
  submissionPhotoCount: number;
  startDate: string;
  createdAt: string;
}

export interface CreateTaskInput {
  childId?: string;
  title?: string;
  scheduleTime?: string;
  repeatType?: RepeatType;
  voiceEnabled?: boolean;
  voiceContent?: string;
  voiceReminderCount?: number;
  claimReminderEnabled?: boolean;
  requiresPhotoUpload?: boolean;
  startDate?: string;
}

export interface RepairTaskStatusInput {
  taskDate?: string;
  status?: "unclaimed" | "claimed" | "completed";
}

export interface SubmissionRow {
  id: string;
  task_id: string;
  child_id: string;
  task_date: string;
  note: string;
  status: "draft" | "submitted";
  created_at: string;
  submitted_at: string | null;
  review_id: string | null;
  review_object_key: string | null;
  review_access_token: string | null;
  review_content_type: string | null;
  review_byte_size: number | null;
  reviewed_at: string | null;
  finalized_at: string | null;
  audio_feedback: string;
  task_title: string;
  schedule_time: string;
  require_photo_upload: number;
  child_name?: string | null;
}

export interface SubmissionPhotoRow {
  id: string;
  submission_id: string;
  object_key: string;
  access_token: string;
  content_type: string;
  byte_size: number;
  created_at: string;
}

export interface SubmissionPhotoDto {
  id: string;
  url: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

export interface SubmissionAudioRow {
  id: string;
  submission_id: string;
  object_key: string;
  access_token: string;
  content_type: string;
  byte_size: number;
  duration_ms: number;
  created_at: string;
}

export interface SubmissionAudioDto {
  id: string;
  url: string;
  contentType: string;
  byteSize: number;
  durationMs: number;
  createdAt: string;
}

export interface SubmissionReviewRoundDto {
  id: string;
  sequence: number;
  note: string;
  feedback: string;
  photos: SubmissionPhotoDto[];
  audios: SubmissionAudioDto[];
  reviewImages: SubmissionPhotoDto[];
  reviewImageUrl: string;
  submittedAt: string | null;
  reviewedAt: string;
}

export interface SubmissionDto {
  id: string;
  taskId: string;
  childId: string;
  childName?: string;
  taskDate: string;
  taskTitle: string;
  scheduleTime: string;
  note: string;
  status: "draft" | "submitted";
  photoCount: number;
  photos: SubmissionPhotoDto[];
  audio: SubmissionAudioDto | null;
  audioFeedback: string;
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  finalizedAt: string | null;
  reviewImageUrl: string | null;
  reviewRounds: SubmissionReviewRoundDto[];
}

export interface NotificationRow {
  id: string;
  recipient_user_id: string;
  submission_id: string | null;
  type: string;
  title: string;
  content: string;
  read_at: string | null;
  created_at: string;
}

export interface NotificationDto {
  id: string;
  submissionId: string | null;
  type: string;
  title: string;
  content: string;
  readAt: string | null;
  createdAt: string;
}

export interface AiOverviewEvidence {
  taskId: string;
  childId: string;
  childName: string;
  taskTitle: string;
  occurrenceDate: string;
  detail: string;
}

export interface AiOverviewInsight {
  id: string;
  tone: "positive" | "attention" | "neutral";
  title: string;
  summary: string;
  evidence: AiOverviewEvidence[];
  action: null | {
    type: "reminder_shift" | "task_breakdown";
    title: string;
    description: string;
    changeMinutes?: number;
    trialDays: 7;
  };
}

export interface AiHomeOverviewDto {
  generatedAt: string;
  analysisMode: "deterministic";
  period: { days: 7 | 28; from: string; to: string };
  scope: { childId: string | null; childName: string };
  dataStatus: "ready" | "insufficient";
  confidence: "high" | "medium" | "low";
  summary: { title: string; description: string };
  metrics: {
    totalTasks: number;
    completionRate: number;
    completionRateDelta: number | null;
    onTimeRate: number | null;
    averageClaimDelayMinutes: number | null;
    revisionRate: number | null;
  };
  trend: Array<{ date: string; completed: number; total: number }>;
  insights: AiOverviewInsight[];
}

export interface AiModelAnalysisContent {
  parentSummary: {
    title: string;
    description: string;
  };
  childNextStep: {
    title: string;
    description: string;
  };
}

export interface AiAnalysisSnapshotDto {
  childId: string;
  childName: string;
  analysisDate: string;
  periodDays: number;
  model: string;
  generatedAt: string;
  result: AiModelAnalysisContent;
}

export interface ChildNextStepDto {
  title: string;
  description: string;
  actionLabel: string;
  taskId: string | null;
  taskDate: string | null;
  stage: "claim" | "continue" | "revise" | "waiting" | "complete" | "rest";
  source: "model" | "rules";
  generatedAt: string | null;
}

export interface ChildHomeAttentionDto {
  notificationId: string;
  title: string;
  description: string;
  taskId: string;
  taskDate: string;
  actionLabel: string;
}

export interface ChildHomeDto {
  date: string;
  greeting: string;
  progress: {
    total: number;
    completed: number;
    pending: number;
    percent: number;
  };
  attention: ChildHomeAttentionDto[];
  nextStep: ChildNextStepDto;
  encouragement: {
    title: string;
    description: string;
    source: "facts";
  };
  syncedAt: string;
}
