// Общие модели данных (сущности ядра, БД и клиентов)

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'archived';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: number; // timestamp
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startTime: number;
  endTime: number;
  allDay?: boolean;
  reminderMinutes?: number;
  createdAt: number;
}

export type TimerState = 'idle' | 'running' | 'paused' | 'completed';

export interface TimerAction {
  type: 'notify' | 'script';
  target?: 'server' | 'client';
  command?: string;
  message?: string;
}

export interface Timer {
  id: string;
  name: string;
  durationSeconds: number;
  remainingSeconds: number;
  state: TimerState;
  action?: TimerAction;
  startedAt?: number;
  createdAt: number;
}

export interface BacklogItem {
  id: string;
  sphere: string; // Сфера жизни (работа, здоровье, развитие, быт и т.д.)
  title: string;
  description?: string;
  priority: number;
  status: 'backlog' | 'scheduled' | 'done';
  createdAt: number;
}

export interface Job {
  id: string;
  name: string;
  cronExpression: string;
  target: 'server' | 'client';
  action: string;
  params?: Record<string, unknown>;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

export interface ClientNode {
  id: string;
  name: string;
  platform: 'darwin' | 'linux' | 'win32';
  lastSeen: number;
  status: 'online' | 'offline';
}
