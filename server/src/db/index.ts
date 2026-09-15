import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL } from './schema.js';
import type { Task, TaskStatus, CalendarEvent, Job, ClientNode, CreateTaskDto, UpdateTaskDto, CreateEventDto } from '@organizer/shared';

export interface DbClientRow {
  id: string;
  name: string;
  platform: string;
  last_seen: number;
  status: string;
}

export interface DbJobRow {
  id: string;
  name: string;
  cron_expression: string;
  target: string;
  action: string;
  params: string | null;
  enabled: number;
  last_run: number | null;
  next_run: number | null;
}

export interface DbTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: number | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

export interface DbEventRow {
  id: string;
  title: string;
  description: string | null;
  start_time: number;
  end_time: number;
  all_day: number;
  reminder_minutes: number | null;
  created_at: number;
}

export class Database {
  public db: DatabaseSync;

  constructor(location: string = ':memory:') {
    this.db = new DatabaseSync(location);
    this.init();
  }

  private init() {
    this.db.exec(SCHEMA_SQL);
  }

  // --- Tasks ---

  /**
   * Список задач. Без фильтра — все. Один статус или массив — `WHERE status IN (...)`.
   * Массив нужен веб-фильтру «активные» (4 статуса = 1 запрос, не 4).
   */
  getTasks(status?: TaskStatus | readonly TaskStatus[]): Task[] {
    if (status === undefined) {
      // stmt = statement: Prepared Statement — SQL, заранее разобранный SQLite.
      const stmt = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');
      return (stmt.all() as unknown as DbTaskRow[]).map(this.mapTaskRow);
    }

    const statuses = Array.isArray(status) ? status : [status];
    if (statuses.length === 0) return [];

    // Placeholders — плейсхолдеры `?` в SQL. Число знаков = числу статусов:
    // SQLite не разворачивает массив в одном `?`, нужен `IN (?, ?, ?)`.
    // Значения биндятся `stmt.all(...statuses)`, в строку не склеиваются —
    // bind, не конкатенация: защита от SQL Injection на query string.
    const placeholders = statuses.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at DESC`
    );
    return (stmt.all(...statuses) as unknown as DbTaskRow[]).map(this.mapTaskRow);
  }

  getTaskById(id: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as unknown as DbTaskRow | undefined;
    return row ? this.mapTaskRow(row) : null;
  }

  /**
   * Быстрый подсчет общего числа задач в базе (O(1) по индексу)
   * для проверки лимита объема задач (Hard Cap).
   */
  getTasksCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM tasks');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  createTask(dto: CreateTaskDto): Task {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      title: dto.title,
      description: dto.description,
      status: (dto as { status?: Task['status'] }).status || 'todo',
      priority: dto.priority || 'medium',
      dueDate: dto.dueDate,
      tags: dto.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, due_date, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.title,
      task.description || null,
      task.status,
      task.priority,
      task.dueDate || null,
      JSON.stringify(task.tags || []),
      task.createdAt,
      task.updatedAt
    );

    return task;
  }

  updateTask(id: string, dto: UpdateTaskDto): Task | null {
    const existing = this.getTaskById(id);
    if (!existing) return null;

    const updated: Task = {
      ...existing,
      title: dto.title ?? existing.title,
      description: dto.description ?? existing.description,
      status: dto.status ?? existing.status,
      priority: dto.priority ?? existing.priority,
      dueDate: dto.dueDate ?? existing.dueDate,
      tags: dto.tags ?? existing.tags,
      updatedAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, status = ?, priority = ?, due_date = ?, tags = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updated.title,
      updated.description || null,
      updated.status,
      updated.priority,
      updated.dueDate || null,
      JSON.stringify(updated.tags || []),
      updated.updatedAt,
      id
    );

    return updated;
  }

  deleteTask(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    stmt.run(id);
    return true;
  }

  // --- Events ---

  getEvents(): CalendarEvent[] {
    const stmt = this.db.prepare('SELECT * FROM events ORDER BY start_time ASC');
    const rows = stmt.all() as unknown as DbEventRow[];
    return rows.map(this.mapEventRow);
  }

  createEvent(dto: CreateEventDto): CalendarEvent {
    const now = Date.now();
    const event: CalendarEvent = {
      id: randomUUID(),
      title: dto.title,
      description: dto.description,
      startTime: dto.startTime,
      endTime: dto.endTime,
      allDay: dto.allDay || false,
      reminderMinutes: dto.reminderMinutes,
      createdAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO events (id, title, description, start_time, end_time, all_day, reminder_minutes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.id,
      event.title,
      event.description || null,
      event.startTime,
      event.endTime,
      event.allDay ? 1 : 0,
      event.reminderMinutes || null,
      event.createdAt
    );

    return event;
  }

  deleteEvent(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM events WHERE id = ?');
    stmt.run(id);
    return true;
  }

  // --- Plugin State Key-Value ---

  getPluginState(pluginId: string, key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM plugins_state WHERE plugin_id = ? AND key = ?');
    const row = stmt.get(pluginId, key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setPluginState(pluginId: string, key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO plugins_state (plugin_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(pluginId, key, value);
  }

  // --- Jobs (Cron) ---

  getJobs(): Job[] {
    const stmt = this.db.prepare('SELECT * FROM jobs ORDER BY name ASC');
    const rows = stmt.all() as unknown as DbJobRow[];
    return rows.map(this.mapJobRow);
  }

  getJobById(id: string): Job | null {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id) as unknown as DbJobRow | undefined;
    return row ? this.mapJobRow(row) : null;
  }

  saveJob(job: Job): void {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, name, cron_expression, target, action, params, enabled, last_run, next_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        cron_expression = excluded.cron_expression,
        target = excluded.target,
        action = excluded.action,
        params = excluded.params,
        enabled = excluded.enabled,
        last_run = excluded.last_run,
        next_run = excluded.next_run
    `);

    stmt.run(
      job.id,
      job.name,
      job.cronExpression,
      job.target,
      job.action,
      job.params ? JSON.stringify(job.params) : null,
      job.enabled ? 1 : 0,
      job.lastRun || null,
      job.nextRun || null
    );
  }

  updateJobRun(id: string, lastRun: number, nextRun?: number): void {
    const stmt = this.db.prepare('UPDATE jobs SET last_run = ?, next_run = ? WHERE id = ?');
    stmt.run(lastRun, nextRun || null, id);
  }

  deleteJob(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM jobs WHERE id = ?');
    stmt.run(id);
    return true;
  }

  // --- Sync & Clients ---

  getTasksSince(since: number): Task[] {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE updated_at > ? ORDER BY updated_at ASC');
    const rows = stmt.all(since) as unknown as DbTaskRow[];
    return rows.map(this.mapTaskRow);
  }

  upsertTask(task: Task): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, due_date, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        due_date = excluded.due_date,
        tags = excluded.tags,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > tasks.updated_at
    `);

    stmt.run(
      task.id,
      task.title,
      task.description || null,
      task.status,
      task.priority,
      task.dueDate || null,
      JSON.stringify(task.tags || []),
      task.createdAt,
      task.updatedAt
    );
  }

  getEventsSince(since: number): CalendarEvent[] {
    const stmt = this.db.prepare('SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC');
    const rows = stmt.all(since) as unknown as DbEventRow[];
    return rows.map(this.mapEventRow);
  }

  upsertEvent(event: CalendarEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, title, description, start_time, end_time, all_day, reminder_minutes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        all_day = excluded.all_day,
        reminder_minutes = excluded.reminder_minutes
    `);

    stmt.run(
      event.id,
      event.title,
      event.description || null,
      event.startTime,
      event.endTime,
      event.allDay ? 1 : 0,
      event.reminderMinutes || null,
      event.createdAt
    );
  }

  upsertClient(client: { id: string; name?: string; platform?: string; status?: string }): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO clients (id, name, platform, last_seen, status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, clients.name),
        platform = COALESCE(excluded.platform, clients.platform),
        last_seen = excluded.last_seen,
        status = excluded.status
    `);

    stmt.run(
      client.id,
      client.name || 'Unknown Client',
      client.platform || 'darwin',
      now,
      client.status || 'online'
    );
  }

  getClients(): ClientNode[] {
    const stmt = this.db.prepare('SELECT * FROM clients ORDER BY last_seen DESC');
    const rows = stmt.all() as unknown as DbClientRow[];
    return rows.map(this.mapClientRow);
  }

  close() {
    this.db.close();
  }

  private mapTaskRow(row: DbTaskRow): Task {
    let tags: string[] = [];
    if (row.tags) {
      try {
        tags = JSON.parse(row.tags);
      } catch {
        tags = [];
      }
    }
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      status: row.status as Task['status'],
      priority: row.priority as Task['priority'],
      dueDate: row.due_date || undefined,
      tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEventRow(row: DbEventRow): CalendarEvent {
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      startTime: row.start_time,
      endTime: row.end_time,
      allDay: Boolean(row.all_day),
      reminderMinutes: row.reminder_minutes || undefined,
      createdAt: row.created_at,
    };
  }

  private mapJobRow(row: DbJobRow): Job {
    let params: Record<string, unknown> | undefined;
    if (row.params) {
      try {
        params = JSON.parse(row.params);
      } catch {
        params = undefined;
      }
    }
    return {
      id: row.id,
      name: row.name,
      cronExpression: row.cron_expression,
      target: row.target as Job['target'],
      action: row.action,
      params,
      enabled: Boolean(row.enabled),
      lastRun: row.last_run || undefined,
      nextRun: row.next_run || undefined,
    };
  }

  private mapClientRow(row: DbClientRow): ClientNode {
    return {
      id: row.id,
      name: row.name,
      platform: row.platform as ClientNode['platform'],
      lastSeen: row.last_seen,
      status: row.status as ClientNode['status'],
    };
  }
}
