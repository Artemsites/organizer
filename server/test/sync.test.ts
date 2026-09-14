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
});
