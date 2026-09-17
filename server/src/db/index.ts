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

// Срок хранения выданных строк журнала (Retention): 7 суток в мс.
// Покрывает сон ноутбука и выходные для догона и Last-Event-ID-переподключений (decisions.md, Шаг 8a.1).
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type DeliveryStatus = 'pending' | 'delivered';

export interface Delivery {
  id: string;
  eventId: string;
  fireAt: number;
  deliveredAt?: number;
  status: DeliveryStatus;
  createdAt: number;
}

export interface DbDeliveryRow {
  id: string;
  event_id: string;
  fire_at: number;
  delivered_at: number | null;
  status: string;
  created_at: number;
}

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Due Reminder — срабатывание, чей момент (`fire_at`) уже наступил, а выдачи ещё не было.
 *   «Просроченное» здесь не значит «опоздавшее»: это очередь работы для догона.
 * - Projection (проекция) — чтение только нужных полей вместо `SELECT *` по двум таблицам:
 *   выдача напоминания не имеет права тянуть весь объект события (описание на 2000 символов
 *   уедет в канал доставки и в браузер, где не нужен).
 */
export interface DueReminder {
  deliveryId: string;
  eventId: string;
  fireAt: number;
  title: string;
  startTime: number;
}

export interface DbDueReminderRow {
  delivery_id: string;
  event_id: string;
  fire_at: number;
  title: string;
  start_time: number;
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
      // Нет статуса в DTO → backlog: задача рождается как идея (spec.md §2), в todo её двигает человек.
      status: dto.status ?? 'backlog',
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

  /**
   * Почему запись события и планирование напоминания — одна транзакция, а не два запроса подряд:
   * сбой между ними оставил бы событие в календаре без напоминания. Это потеря без ошибки в
   * ответе и без строки в логах — ровно тот тихий отказ, от которого предостерегает `decisions.md`
   * («доставить хотя бы раз»). С транзакцией клиент получает 500 и может повторить запрос.
   *
   * Почему хук планирования стоит здесь, а не в роуте `POST /api/v1/events`: в `events` пишут два
   * пути — этот роут и `POST /api/v1/sync` (`upsertEvent`). Хук в роуте оставил бы второй вход
   * без напоминаний, а хук в каждом вызывающем — это два места, которые разъедутся (SSoT).
   */
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

    // `?? null`, а не `|| null`: интервал `0` — законное значение («напомнить в момент начала»),
    // а `||` превратил бы его в NULL, и напоминание исчезло бы молча уже на записи.
    this.transaction(() => {
      stmt.run(
        event.id,
        event.title,
        event.description || null,
        event.startTime,
        event.endTime,
        event.allDay ? 1 : 0,
        event.reminderMinutes ?? null,
        event.createdAt
      );

      this.planEventReminder(event);
    });

    return event;
  }

  deleteEvent(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM events WHERE id = ?');
    stmt.run(id);
    return true;
  }

  // --- Delivery Log (журнал срабатываний напоминаний) ---

  /**
   * Best Practice: Idempotency Key на уровне СУБД (а не флаг в памяти).
   * Пара (event_id, fire_at) — естественный идемпотентный ключ: одно событие в один момент
   * срабатывает один раз. UNIQUE-индекс отклоняет дубль исключением SQLite, переживая рестарт.
   * Намеренно без предварительной SELECT-проверки (check-then-insert — Race Condition / TOCTOU:
   * два подписчика вклинятся между проверкой и вставкой). Исключение пробрасываем наружу:
   * отклоняет хранилище, а не прикладной код (требование приёмки 8a.1).
   */
  scheduleDelivery(eventId: string, fireAt: number): Delivery {
    const now = Date.now();
    const row: Delivery = {
      id: randomUUID(),
      eventId,
      fireAt,
      status: 'pending',
      createdAt: now,
    };
    const stmt = this.db.prepare(`
      INSERT INTO delivery_log (id, event_id, fire_at, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(row.id, row.eventId, row.fireAt, row.status, row.createdAt);
    return row;
  }

  getDeliveriesByEvent(eventId: string): Delivery[] {
    const stmt = this.db.prepare('SELECT * FROM delivery_log WHERE event_id = ? ORDER BY fire_at ASC');
    const rows = stmt.all(eventId) as unknown as DbDeliveryRow[];
    return rows.map(this.mapDeliveryRow);
  }

  /**
   * Best Practice: Idempotent Write (идемпотентная запись).
   * Условие WHERE status = 'pending' делает повторный вызов no-op: фоновая джоба (Шаг 8a.3)
   * может безопасно перебирать просроченные строки — уже выданная не выдастся дважды.
   * Возвращает true, если строка перешла в 'delivered' этим вызовом.
   */
  markDelivered(id: string, deliveredAt: number = Date.now()): boolean {
    const stmt = this.db.prepare(`
      UPDATE delivery_log
      SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = stmt.run(deliveredAt, id) as unknown as { changes: number | bigint };
    return Number(result.changes) > 0;
  }

  /**
   * Best Practice: Bounded Growth (ограниченный рост таблицы).
   * Выданные строки старше cutoff удаляются той же джобой, что разбирает журнал, —
   * иначе повторяющиеся события заполняют диск в обход hard cap Шага 7.0.3.
   * Невыданные строки не трогаем никогда, даже старые: это backlog догона после простоя (Шаг 8a.3).
   */
  pruneDeliveredOlderThan(cutoff: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM delivery_log
      WHERE status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < ?
    `);
    const result = stmt.run(cutoff) as unknown as { changes: number | bigint };
    return Number(result.changes);
  }

  /**
   * Best Practice: Single Source of Truth для момента срабатывания.
   * Момент не хранится отдельным полем события — он выводится из `startTime` и `reminderMinutes`
   * одним правилом (`fire_at = start_time − reminder_minutes × 60 000`). Храни его вторым полем,
   * перенос начала события оставил бы старое значение в живых — классический рассинхрон копии.
   *
   * Почему DELETE, а не UPDATE: перенос начала и смена интервала делают прежнюю невыданную строку
   * мусором, и она сработала бы в старом времени, а потом ещё раз в новом — два напоминания об
   * одном событии. Удаляем строго `status = 'pending'`: выданная строка — история доставки и,
   * кроме того, держит UNIQUE-пару (event_id, fire_at), по которой повтор не запланируется.
   *
   * Почему `ON CONFLICT DO NOTHING`, а не голый INSERT: синхронизация шлёт событие тем же объектом
   * повторно, и второй INSERT наткнулся бы на UNIQUE-индекс — исключение вылетело бы наружу в виде
   * 500 на совершенно законном запросе. NOOP здесь и есть идемпотентность: тот же вход — тот же
   * результат, без второго срабатывания.
   *
   * Вызывается только из транзакции записи события (`createEvent`, `upsertEvent`): отдельным
   * вызовом DELETE и INSERT разъехались бы при сбое, и напоминание пропало бы молча.
   */
  private planEventReminder(event: CalendarEvent): void {
    this.db
      .prepare(`DELETE FROM delivery_log WHERE event_id = ? AND status = 'pending'`)
      .run(event.id);

    // Проверка именно на `undefined`: `0` — допустимый интервал, `if (!event.reminderMinutes)`
    // выбросил бы «напомнить в момент начала» без единого следа в логах.
    if (event.reminderMinutes === undefined) return;

    const fireAt = event.startTime - event.reminderMinutes * 60_000;
    this.db
      .prepare(`
        INSERT INTO delivery_log (id, event_id, fire_at, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
        ON CONFLICT(event_id, fire_at) DO NOTHING
      `)
      .run(randomUUID(), event.id, fireAt, Date.now());
  }

  /**
   * Best Practice: Claim-then-Deliver — «забрал строку, она моя».
   * Чтение просроченных и пометка «выдано» идут одной транзакцией: между двумя отдельными
   * запросами успевает вклиниться второй подписчик, и одно напоминание уходит дважды.
   * UNIQUE-индекс от этого не защищает — он защищает от повторного планирования, а не от
   * повторной выдачи (decisions.md, Шаг 8a.4).
   *
   * Почему условие `fire_at <= now`, а не «попал в текущую минуту»: это догон. Ноутбук, закрытый
   * на ночь (или засыпание приложения на Beget вместе с планировщиком — issues.md), иначе молча
   * терял бы напоминания: тихий отказ, которого никто не заметит.
   */
  claimDueReminders(now: number): DueReminder[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(`
          SELECT d.id AS delivery_id, d.event_id, d.fire_at, e.title, e.start_time
          FROM delivery_log d
          JOIN events e ON e.id = d.event_id
          WHERE d.status = 'pending' AND d.fire_at <= ?
          ORDER BY d.fire_at ASC
        `)
        .all(now) as unknown as DbDueReminderRow[];

      const updated = this.db
        .prepare(`
          UPDATE delivery_log
          SET status = 'delivered', delivered_at = ?
          WHERE status = 'pending' AND fire_at <= ?
        `)
        .run(now, now) as unknown as { changes: number | bigint };

      // Инвариант «ровно один раз»: число помеченных обязано совпасть с числом прочитанных.
      // Расхождение означает, что кто-то забрал строку между чтением и пометкой, — это не
      // «мелкая неточность», а уже случившаяся двойная выдача. Откат и исключение громче молчания.
      if (Number(updated.changes) !== rows.length) {
        throw new Error(
          `Delivery claim mismatch: read ${rows.length}, marked ${Number(updated.changes)}`
        );
      }

      return rows.map(this.mapDueReminderRow);
    });
  }

  /**
   * Best Practice: Explicit Transaction Boundary (явная граница транзакции).
   * Несколько записей, обязанных попасть в БД вместе или не попасть вовсе.
   *
   * Почему без вложенности: SQLite не умеет вложенные транзакции
   * (`cannot start a transaction within a transaction`), поэтому каждый публичный метод открывает
   * ровно одну, а общий код планирования (`planEventReminder`) вкладывается в неё как функция —
   * своей транзакции он не начинает.
   *
   * Отвергнута альтернатива «пусть каждая запись идёт своей автотранзакцией»: сбой посередине
   * оставил бы данные в полусостоянии (событие без напоминания) без ошибки в ответе клиенту.
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  /**
   * Почему `upsertEvent` тоже планирует напоминание: это второй вход в таблицу `events`
   * (`POST /api/v1/sync`), и без него событие, приехавшее синхронизацией, осталось бы без
   * срабатывания — то же правило должно работать на всех входах (SSoT момента срабатывания
   * живёт в `planEventReminder`, а не в роутах).
   */
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

    this.transaction(() => {
      stmt.run(
        event.id,
        event.title,
        event.description || null,
        event.startTime,
        event.endTime,
        event.allDay ? 1 : 0,
        event.reminderMinutes ?? null,
        event.createdAt
      );

      this.planEventReminder(event);
    });
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
      // `?? undefined`, а не `|| undefined`: интервал `0` — это «напомнить в момент начала»,
      // и `||` вернул бы клиенту `undefined` — напоминание выглядело бы отключённым на чтении,
      // хотя в БД и в журнале доставки оно есть.
      reminderMinutes: row.reminder_minutes ?? undefined,
      createdAt: row.created_at,
    };
  }

  private mapDeliveryRow(row: DbDeliveryRow): Delivery {
    return {
      id: row.id,
      eventId: row.event_id,
      fireAt: row.fire_at,
      deliveredAt: row.delivered_at || undefined,
      status: row.status as DeliveryStatus,
      createdAt: row.created_at,
    };
  }

  private mapDueReminderRow(row: DbDueReminderRow): DueReminder {
    return {
      deliveryId: row.delivery_id,
      eventId: row.event_id,
      fireAt: row.fire_at,
      title: row.title,
      startTime: row.start_time,
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
