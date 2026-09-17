import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, registerServerPlugin } from '../src/index.js';
import { DEFAULT_TOKEN } from '../src/auth.js';
import type { Task, CalendarEvent } from '@organizer/shared';

describe('Organizer Server: Sync & Plugins Distribution', () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    server = await createServer({ dbLocation: ':memory:', startScheduler: false });
  });

  afterEach(async () => {
    await server.app.close();
  });

  it('POST /api/v1/sync регистрирует клиента и синхронизирует задачи', async () => {
    const clientTask: Task = {
      id: 'task-client-1',
      title: 'Задача созданная на Mac CLI',
      status: 'todo',
      priority: 'high',
      createdAt: 1000,
      updatedAt: 1000,
    };

    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
      payload: {
        clientId: 'mac-worker-artem',
        lastSyncAt: 0,
        tasks: [clientTask],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.tasks.length).toBe(1);
    expect(body.data.tasks[0].id).toBe('task-client-1');

    // Проверяем список зарегистрированных клиентов
    const clientsRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/clients',
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
    });

    expect(clientsRes.statusCode).toBe(200);
    const clientsBody = JSON.parse(clientsRes.body);
    expect(clientsBody.data.length).toBe(1);
    expect(clientsBody.data[0].id).toBe('mac-worker-artem');
    expect(clientsBody.data[0].status).toBe('online');
  });

  it('двусторонняя синхронизация между двумя клиентами', async () => {
    // Клиент A загружает задачу
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        clientId: 'client-A',
        lastSyncAt: 0,
        tasks: [
          {
            id: 'task-from-a',
            title: 'Заметка от Клиента А',
            status: 'todo',
            priority: 'medium',
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      },
    });

    // Клиент B подключается и получает задачу Клиента A
    const syncB = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        clientId: 'client-B',
        lastSyncAt: 0,
      },
    });

    const bodyB = JSON.parse(syncB.body);
    expect(bodyB.data.tasks.length).toBe(1);
    expect(bodyB.data.tasks[0].id).toBe('task-from-a');
  });

  it('GET /api/v1/plugins отдает список и клиентские бандлы плагинов', async () => {
    registerServerPlugin(
      {
        id: 'timer-plugin',
        name: 'Timer Plugin',
        version: '1.0.0',
        capabilities: ['server', 'client'],
      },
      'export default { onInit() { console.log("Timer client loaded"); } };'
    );

    // 1. Список плагинов
    const listRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/plugins',
      headers: { 'x-client-token': DEFAULT_TOKEN },
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.data.some((p: { id: string }) => p.id === 'timer-plugin')).toBe(true);

    // 2. Раздача клиентской части
    const bundleRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/timer-plugin/client',
      headers: { 'x-client-token': DEFAULT_TOKEN },
    });

    expect(bundleRes.statusCode).toBe(200);
    expect(bundleRes.headers['content-type']).toContain('application/javascript');
    expect(bundleRes.body).toContain('Timer client loaded');
  });

  /**
   * ENGLISH PROGRAMMER CONCEPTS:
   * - Boundary Validation — проверка недоверенного ввода на границе системы.
   * - Per-Record Quarantine — поштучный карантин: кривая запись отбрасывается,
   *   соседние корректные применяются, пакет в целом остаётся 200.
   * - State Preservation — отклонённый запрос не мутирует БД и не планирует срабатываний.
   *
   * Урок Шага 7b.1: под каждым тестом указано, какое изменение кода обязано его покраснить.
   */
  function postSync(payload: unknown) {
    return server.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload,
    });
  }

  /**
   * Обещание: мусорный интервал не доезжает до БД и не планирует срабатывание,
   * соседняя корректная запись применяется, пакет остаётся 200.
   * Краснеет при: возврате прямого `db.upsertEvent(event)` мимо схемы —
   * мусор ляжет в базу, в журнале появится строка, `rejectedEvents` станет 0.
   */
  it('событие с отрицательным интервалом отклоняется, соседнее корректное применяется', async () => {
    const now = Date.now();
    const bad = {
      id: 'evt-bad-1',
      title: 'Мусор',
      startTime: now + 3_600_000,
      endTime: now + 7_200_000,
      reminderMinutes: -5,
      createdAt: now,
    };
    const good = {
      id: 'evt-good-1',
      title: 'Созвон',
      startTime: now + 3_600_000,
      endTime: now + 7_200_000,
      reminderMinutes: 10,
      createdAt: now,
    };

    const res = await postSync({ clientId: 'client-A', lastSyncAt: 0, events: [bad, good] });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.rejectedEvents).toBe(1);
    expect(server.db.getEvents().map((e) => e.id)).toEqual(['evt-good-1']);
    expect(server.db.getDeliveriesByEvent('evt-bad-1')).toHaveLength(0);
    expect(server.db.getDeliveriesByEvent('evt-good-1')).toHaveLength(1);
  });

  /**
   * Обещание: запись с чужим `id`, но полями вне контракта не затирает существующую строку.
   * Краснеет при: прямом `db.upsertEvent(event)` мимо схемы — заголовок затрется
   * 10 000 символов поверх существующего.
   */
  it('запись с чужим id и полями вне схемы не затирает существующую строку', async () => {
    const now = Date.now();
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: { title: 'Планёрка', startTime: now + 3_600_000, endTime: now + 7_200_000 },
    });
    const id = JSON.parse(created.body).data.id as string;

    const res = await postSync({
      clientId: 'client-A',
      lastSyncAt: 0,
      events: [
        {
          id,
          title: 'x'.repeat(10_000),
          startTime: now + 3_600_000,
          endTime: now + 7_200_000,
          createdAt: now,
          role: 'admin',
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    const stored = server.db.getEvents();
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('Планёрка');
    expect(stored[0]).not.toHaveProperty('role');
  });

  /**
   * Обещание: кривая задача отбрасывается тем же проходом, соседняя применяется.
   * Краснеет при: прямом `db.upsertTask(task)` мимо схемы — `CHECK` в SQLite бросит
   * исключение и весь запрос упадёт в 500 вместо 200 с `rejectedTasks: 1`.
   */
  it('задача с невалидным статусом отбрасывается, соседняя применяется', async () => {
    const now = Date.now();
    const badTask = {
      id: 'task-bad-1',
      title: 'Мусор',
      status: 'lol',
      priority: 'medium',
      createdAt: now,
      updatedAt: now,
    };
    const goodTask = {
      id: 'task-good-1',
      title: 'Купить молоко',
      status: 'todo',
      priority: 'medium',
      createdAt: now,
      updatedAt: now,
    };

    const res = await postSync({ clientId: 'client-A', lastSyncAt: 0, tasks: [badTask, goodTask] });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.rejectedTasks).toBe(1);
    expect(server.db.getTaskById('task-bad-1')).toBeNull();
    expect(server.db.getTaskById('task-good-1')?.title).toBe('Купить молоко');
  });
});
