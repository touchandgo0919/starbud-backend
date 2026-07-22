export interface Env {
  DB: D1Database;
  ADMIN_INITIAL_PASSWORD?: string;
  INITIAL_PASSWORD_SUFFIX?: string;
  JWT_SECRET?: string;
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
  voiceContent: string;
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
  voiceContent?: string;
}
