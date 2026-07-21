export interface Env {
  DB: D1Database;
  JWT_SECRET?: string;
}

export type RepeatType = "once" | "daily" | "weekdays" | "weekly";

export type UserRole = "parent" | "child";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  created_at: string;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface ChildDto {
  id: string;
  name: string;
  deviceId: string | null;
}

export interface TaskRow {
  id: string;
  child_id: string;
  title: string;
  schedule_time: string;
  repeat_type: RepeatType;
  voice_enable: number;
  active: number;
  created_at: string;
  record_status: string | null;
  completed_at: string | null;
}

export interface TaskDto {
  id: string;
  childId: string;
  title: string;
  scheduleTime: string;
  repeatType: RepeatType;
  voiceEnabled: boolean;
  status: "pending" | "completed" | "missed";
  completedAt: string | null;
  createdAt: string;
}

export interface CreateTaskInput {
  childId?: string;
  title?: string;
  scheduleTime?: string;
  repeatType?: RepeatType;
  voiceEnabled?: boolean;
}
