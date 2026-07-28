export interface Env {
  APP_TIME_ZONE?: string;
  DB: D1Database;
  SUBMISSION_FILES: R2Bucket;
  ADMIN_INITIAL_PASSWORD?: string;
  INITIAL_PASSWORD_SUFFIX?: string;
  JWT_SECRET?: string;
  SEED_DEMO_USERS?: string;
}

export type RepeatType = "once" | "daily" | "weekdays" | "weekly";

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
  active: number;
  created_at: string;
  record_status: string | null;
  record_date: string | null;
  completed_at: string | null;
  claimed_at: string | null;
  submission_id: string | null;
  submission_status: string | null;
  reviewed_at: string | null;
  finalized_at: string | null;
  submission_photo_count: number | null;
}

export interface TaskDto {
  id: string;
  childId: string;
  title: string;
  scheduleTime: string;
  repeatType: RepeatType;
  voiceEnabled: boolean;
  voiceContent: string;
  voiceReminderCount: number;
  status: "pending" | "completed" | "missed";
  occurrenceDate: string | null;
  completedAt: string | null;
  claimedAt: string | null;
  submissionId: string | null;
  submissionStatus: "draft" | "submitted" | null;
  reviewedAt: string | null;
  finalizedAt: string | null;
  needsRevision: boolean;
  submissionPhotoCount: number;
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
  task_title: string;
  schedule_time: string;
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
}

export interface SubmissionReviewRoundDto {
  id: string;
  sequence: number;
  note: string;
  photos: SubmissionPhotoDto[];
  reviewImages: SubmissionPhotoDto[];
  reviewImageUrl: string;
  reviewedAt: string;
}

export interface SubmissionDto {
  id: string;
  taskId: string;
  childId: string;
  taskDate: string;
  taskTitle: string;
  scheduleTime: string;
  note: string;
  status: "draft" | "submitted";
  photoCount: number;
  photos: SubmissionPhotoDto[];
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
