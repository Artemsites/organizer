import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/db/index.js';
import { createServer } from '../src/index.js';
import { DEFAULT_TOKEN } from '../src/auth.js';

describe('Organizer Server: Database CRUD', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('создает задачу и возвращает ее в списке', () => {
    const task = db.createTask({
      title: 'Купить хлеб',
      priority: 'high',
      tags: ['быт', 'покупки'],
    });

    expect(task.id).toBeDefined();
    expect(task.title).toBe('Купить хлеб');
    expect(task.status).toBe('backlog');
    expect(task.priority).toBe('high');
    expect(task.tags).toEqual(['быт', 'покупки']);

    const tasks = db.getTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(task.id);
  });

  it('обновляет статус и заголовок задачи', () => {
    const task = db.createTask({ title: 'Старая задача' });
    const updated = db.updateTask(task.id, {
      title: 'Новая задача',
      status: 'done',
    });

    expect(updated).not.toBeNull();
    expect(updated?.title).toBe('Новая задача');
    expect(updated?.status).toBe('done');

    const fetched = db.getTaskById(task.id);
    expect(fetched?.status).toBe('done');
  });

  it('удаляет задачу', () => {
    const task = db.createTask({ title: 'На удаление' });
    db.deleteTask(task.id);
    const fetched = db.getTaskById(task.id);
    expect(fetched).toBeNull();
  });

  it('сохраняет и читает состояние плагинов (Key-Value)', () => {
    db.setPluginState('timer-plugin', 'lastRun', '123456');
    const val = db.getPluginState('timer-plugin', 'lastRun');
    expect(val).toBe('123456');

    // Перезапись (upsert)
    db.setPluginState('timer-plugin', 'lastRun', '789012');
    expect(db.getPluginState('timer-plugin', 'lastRun')).toBe('789012');
  });
});

describe('Organizer Server: Fastify REST API & Auth', () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    server = await createServer({ dbLocation: ':memory:' });
  });

  afterEach(async () => {
    await server.app.close();
  });

  it('GET /health доступен публично без токена', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
  });

  it('GET /api/v1/tasks возвращает 401 при отсутствии x-client-token', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Unauthorized');
  });

  it('POST и GET /api/v1/tasks успешно работают с правильным токеном', async () => {
    // 1. Создание задачи
    const createRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
      payload: {
        title: 'Тестовая задача через API',
        priority: 'high',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const createdBody = JSON.parse(createRes.body);
    expect(createdBody.success).toBe(true);
    expect(createdBody.data.title).toBe('Тестовая задача через API');

    // 2. Получение списка
    const listRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.success).toBe(true);
    expect(listBody.data.length).toBe(1);
    expect(listBody.data[0].title).toBe('Тестовая задача через API');
  });
});
