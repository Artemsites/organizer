// DTO и типы взаимодействия по REST API

import type { Task, CalendarEvent, Timer, BacklogItem } from './models.js';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface AuthHeaders {
  'x-client-token': string;
}

export interface CreateTaskDto {
  title: string;
  description?: string;
  priority?: Task['priority'];
  dueDate?: number;
  tags?: string[];
}

export interface UpdateTaskDto {
  title?: string;
  description?: string;
  status?: Task['status'];
  priority?: Task['priority'];
  dueDate?: number;
  tags?: string[];
}

export interface CreateEventDto {
  title: string;
  description?: string;
  startTime: number;
  endTime: number;
  allDay?: boolean;
  reminderMinutes?: number;
}

export interface CreateTimerDto {
  name: string;
  durationSeconds: number;
  action?: Timer['action'];
}

export interface SyncPayload {
  clientId: string;
  lastSyncAt: number;
  tasks?: Task[];
  events?: CalendarEvent[];
  backlog?: BacklogItem[];
}

export interface SyncResult {
  serverTimestamp: number;
  tasks: Task[];
  events: CalendarEvent[];
  backlog: BacklogItem[];
}
