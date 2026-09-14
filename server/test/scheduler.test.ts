import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../src/db/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { createServer } from '../src/index.js';
import { DEFAULT_TOKEN } from '../src/auth.js';

describe('Organizer Server: Scheduler Engine', () => {
  let db: Database;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = new Database(':memory:');
    scheduler = new Scheduler(db);
  });

  afterEach(() => {
    scheduler.stopAll();
    db.close();
  });

  it('регистрирует задачу cron и выполняет обработчик при triggerJob', async () => {
    let executed = false;
    let handledJobId = '';

    scheduler.registerHandler('test:ping', (job) => {
      executed = true;
      handledJobId = job.id;
    });

    const job = scheduler.addJob({
      name: 'Ping Job',
      cronExpression: '0 * * * *', // каждый час
      action: 'test:ping',
      target: 'server',
    });

    expect(job.id).toBeDefined();
    expect(job.name).toBe('Ping Job');
    expect(job.nextRun).toBeDefined();

    const ok = await scheduler.triggerJob(job.id);
    expect(ok).toBe(true);
    expect(executed).toBe(true);
    expect(handledJobId).toBe(job.id);

    // Проверяем обновление lastRun в БД
    const fromDb = db.getJobById(job.id);
    expect(fromDb?.lastRun).toBeDefined();
  });

  it('сохраняет задачи в БД и восстанавливает их при новом старте', () => {
    scheduler.addJob({
      name: 'Persistent Job',
      cronExpression: '*/5 * * * *',
      action: 'backup:run',
    });

    expect(scheduler.listJobs().length).toBe(1);

    // Создаем новый экземпляр планировщика над той же БД
    const newScheduler = new Scheduler(db);
    newScheduler.start();

    const loadedJobs = newScheduler.listJobs();
    expect(loadedJobs.length).toBe(1);
    expect(loadedJobs[0].name).toBe('Persistent Job');
    newScheduler.stopAll();
  });

  it('добавляет и отменяет одноразовый таймер', async () => {
    let timerFired = false;
    const cancel = scheduler.addTimer(20, () => {
      timerFired = true;
    });

    // Отменяем до срабатывания
    cancel();

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(timerFired).toBe(false);
  });
});

describe('Organizer Server: Jobs REST API', () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    server = await createServer({ dbLocation: ':memory:', startScheduler: false });
  });

  afterEach(async () => {
    await server.app.close();
  });

  it('POST, GET, TRIGGER и DELETE /api/v1/jobs', async () => {
    // 1. Создание задачи через API
    const createRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
      payload: {
        name: 'Ежедневная очистка логов',
        cronExpression: '0 0 * * *',
        action: 'cleanup:logs',
        target: 'server',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.success).toBe(true);
    expect(created.data.name).toBe('Ежедневная очистка логов');
    const jobId = created.data.id;

    // 2. Получение списка задач
    const listRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.data.length).toBe(1);
    expect(list.data[0].id).toBe(jobId);

    // 3. Ручной триггер задачи
    const triggerRes = await server.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/trigger`,
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
    });

    expect(triggerRes.statusCode).toBe(200);
    const triggerBody = JSON.parse(triggerRes.body);
    expect(triggerBody.success).toBe(true);

    // 4. Удаление задачи
    const deleteRes = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/jobs/${jobId}`,
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
    });

    expect(deleteRes.statusCode).toBe(200);

    // 5. Проверка пустого списка
    const emptyListRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: {
        'x-client-token': DEFAULT_TOKEN,
      },
    });
    const emptyList = JSON.parse(emptyListRes.body);
    expect(emptyList.data.length).toBe(0);
  });
});
