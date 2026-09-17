import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/index.js';
import { DEFAULT_TOKEN } from '../src/auth.js';
import { DELIVERY_RETENTION_MS } from '../src/db/index.js';
import type { CalendarEvent } from '@organizer/shared';
import {
  REMINDER_TICK_ACTION,
  REMINDER_TICK_CRON,
  registerReminderDispatch,
  runReminderTick,
} from '../src/reminders.js';

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Tick (тик) — периодический проход джобы, который забирает накопившуюся работу.
 * - Catch-up (догон) — обработка всей просрочки, а не только попавшей в текущую минуту.
 * - Clock Injection (подмена часов) — «сейчас» приходит аргументом, поэтому простой в три часа
 *   проверяется одним числом, а не ожиданием реального времени: прогон быстрый и детерминированный.
 * - Idempotency (идемпотентность) — повторный вызов с тем же входом не создаёт нового эффекта.
 *
 * Урок Шага 7b.1: имя теста — обещание, проверка — его тело. Под каждым тестом указано, какое
 * изменение кода обязано его покраснить; если он остаётся зелёным после такого изменения — он лжёт.
 *
 * Прогон: `npm --prefix server run test`
 */
describe('Organizer Server: планирование напоминаний и минутный тик (Шаг 8a.3)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  let server: Awaited<ReturnType<typeof createServer>>;

  // Планировщик выключен: живой крон `* * * * *` забрал бы строки прямо посреди прогона, и счётчики
  // стали бы плавающими на границе минуты. Здесь тик зовётся руками — с подменённым «сейчас».
  beforeEach(async () => {
    server = await createServer({ dbLocation: ':memory:', startScheduler: false });
  });

  afterEach(async () => {
    await server.app.close();
  });

  /** Событие, срабатывание которого приходится на `fireAt`: начало выводится из интервала напоминания. */
  function makeEvent(fireAt: number, reminderMinutes = 10, title = 'Встреча'): CalendarEvent {
    const startTime = fireAt + reminderMinutes * MINUTE;
    return server.db.createEvent({
      title,
      startTime,
      endTime: startTime + HOUR,
      reminderMinutes,
    });
  }

  /** Второй вход в таблицу событий — синхронизация с Mac-воркером (`upsertEvent`). */
  async function pushEvent(event: CalendarEvent) {
    return server.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: { clientId: 'mac-worker-test', lastSyncAt: 0, events: [event] },
    });
  }

  it('POST /api/v1/events планирует срабатывание на startTime − reminderMinutes', async () => {
    const now = Date.now();
    const startTime = now + 5 * MINUTE;

    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: { title: 'Встреча', startTime, endTime: startTime + HOUR, reminderMinutes: 15 },
    });

    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body).data;

    // Краснеет при: снятии вызова `planEventReminder` из `createEvent`; знаке `+` вместо `−` в формуле
    // (напоминание ушло бы в будущее после начала события); вычитании минут вместо миллисекунд.
    const rows = server.db.getDeliveriesByEvent(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].fireAt).toBe(startTime - 15 * MINUTE);
  });

  it('интервал `0` даёт срабатывание в момент начала, отсутствие интервала — не даёт ничего', async () => {
    const now = Date.now();
    const startTime = now + HOUR;

    const withoutReminder = await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: { title: 'Без напоминания', startTime, endTime: startTime + HOUR },
    });
    const withZero = await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        title: 'Напомнить в момент начала',
        startTime,
        endTime: startTime + HOUR,
        reminderMinutes: 0,
      },
    });

    const noReminder = JSON.parse(withoutReminder.body).data;
    const zero = JSON.parse(withZero.body).data;

    expect(server.db.getDeliveriesByEvent(noReminder.id)).toHaveLength(0);

    // `0` — законный интервал, а не «напоминания нет». Краснеет при: `|| null` при записи события
    // (в БД ушёл бы NULL) и при проверке `if (!event.reminderMinutes)` в `planEventReminder`.
    expect(zero.reminderMinutes).toBe(0);
    const rows = server.db.getDeliveriesByEvent(zero.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].fireAt).toBe(startTime);
  });

  it('минутный тик выдаёт просроченное срабатывание ровно один раз', () => {
    const now = Date.now();
    const event = makeEvent(now - 10 * MINUTE);

    const first = runReminderTick(server.db, now);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      eventId: event.id,
      title: 'Встреча',
      fireAt: event.startTime - 10 * MINUTE,
    });

    // Краснеет при: снятии условия `status = 'pending'` в выборке или в пометке — второй проход
    // выдал бы ту же строку снова, и напоминание ушло бы дважды.
    expect(runReminderTick(server.db, now)).toHaveLength(0);

    const [row] = server.db.getDeliveriesByEvent(event.id);
    expect(row.status).toBe('delivered');
    expect(row.deliveredAt).toBe(now);
  });

  it('догон: три часа простоя отдают все пропущенные срабатывания разом', () => {
    const now = Date.now();
    const fireTimes = [now - 170 * MINUTE, now - 120 * MINUTE, now - 60 * MINUTE, now - 5 * MINUTE];
    for (const [index, fireAt] of fireTimes.entries()) {
      makeEvent(fireAt, 10, `Событие ${index}`);
    }

    // Краснеет при: подмене `fire_at <= now` окном «попал в текущую минуту» — вернулось бы одно
    // срабатывание вместо четырёх, и закрытый на ночь ноутбук молча терял бы напоминания.
    expect(runReminderTick(server.db, now - 175 * MINUTE)).toHaveLength(0);
    const due = runReminderTick(server.db, now);
    expect(due.map((item) => item.fireAt)).toEqual(fireTimes);
  });

  it('снятие интервала напоминания через sync отменяет невыданное срабатывание', async () => {
    const now = Date.now();
    const event = makeEvent(now - 10 * MINUTE);
    expect(server.db.getDeliveriesByEvent(event.id)).toHaveLength(1);

    const res = await pushEvent({ ...event, reminderMinutes: undefined });
    expect(res.statusCode).toBe(200);

    // Краснеет при: снятии DELETE невыданных строк из `planEventReminder` либо снятии вызова
    // оттуда из `upsertEvent` — тик выдал бы отменённое напоминание.
    expect(server.db.getDeliveriesByEvent(event.id)).toHaveLength(0);
    expect(runReminderTick(server.db, now)).toHaveLength(0);
    expect(server.db.getEvents()).toHaveLength(1); // само событие при этом не тронуто
  });

  it('перенос начала события переносит срабатывание, а не добавляет второе', async () => {
    const now = Date.now();
    const event = makeEvent(now - 10 * MINUTE);

    const startTime = now + 2 * HOUR;
    await pushEvent({ ...event, startTime, endTime: startTime + HOUR, reminderMinutes: 30 });

    // Краснеет при: замене DELETE на «просто вставить новое» — в журнале лежали бы две строки,
    // и тик выдал бы напоминание по старому времени, а затем ещё раз по новому.
    const rows = server.db.getDeliveriesByEvent(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].fireAt).toBe(startTime - 30 * MINUTE);
    expect(runReminderTick(server.db, now)).toHaveLength(0);
  });

  it('повторная синхронизация уже выданного события не падает и не напоминает второй раз', async () => {
    const now = Date.now();
    const event = makeEvent(now - 10 * MINUTE);
    expect(runReminderTick(server.db, now)).toHaveLength(1);

    // Тот же момент срабатывания приходит снова: пара (event_id, fire_at) занята выданной строкой.
    // Краснеет при: снятии `ON CONFLICT(event_id, fire_at) DO NOTHING` — исключение UNIQUE вылетит
    // из `upsertEvent`, и законная синхронизация получит 500.
    const res = await pushEvent({ ...event, title: 'Встреча (заголовок правлен на Mac)' });
    expect(res.statusCode).toBe(200);

    expect(server.db.getDeliveriesByEvent(event.id)).toHaveLength(1);
    expect(runReminderTick(server.db, now)).toHaveLength(0);
  });

  it('минутный тик чистит выданное старше retention, не трогая остальное', () => {
    const now = Date.now();
    const event = makeEvent(now - 10 * MINUTE);

    const stale = now - DELIVERY_RETENTION_MS - HOUR;
    const old = server.db.scheduleDelivery(event.id, stale);
    server.db.markDelivered(old.id, stale);

    runReminderTick(server.db, now);

    // Краснеет при: снятии вызова `pruneDeliveredOlderThan` из `runReminderTick` — журнал рос бы
    // без границ в обход hard cap Шага 7.0.3. Пункт приёмки 8a.1 «журнал не растёт бесконечно»
    // закрывается именно этой джобой: до Шага 8a.3 у чистки не было ни одного прод-вызова.
    const ids = server.db.getDeliveriesByEvent(event.id).map((row) => row.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toHaveLength(1); // свежее выданное срабатывание самого события осталось
  });
});

/**
 * Отметка «выдано» лежит в БД, а не в памяти процесса: ровно это отличает at-least-once с дедупом
 * на уровне СУБД от флага «отправлено» в `Map`, который обнуляется первым же рестартом.
 */
describe('Organizer Server: выдача напоминания переживает рестарт (Шаг 8a.3)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  it('после перезапуска сервера уже выданное напоминание не выдаётся повторно', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'organizer-reminders-'));
    const dbPath = join(dir, 'organizer.db');

    try {
      const first = await createServer({ dbLocation: dbPath, startScheduler: false });
      const now = Date.now();
      const event = first.db.createEvent({
        title: 'Встреча',
        startTime: now + 5 * MINUTE,
        endTime: now + 65 * MINUTE,
        reminderMinutes: 15,
      });
      expect(runReminderTick(first.db, now)).toHaveLength(1);
      await first.app.close();

      const second = await createServer({ dbLocation: dbPath, startScheduler: false });
      try {
        // Краснеет при: переносе дедупа в память процесса (флаг «отправлено» в Map вместо статуса
        // строки журнала) — после рестарта пометка исчезла бы, и напоминание ушло бы второй раз.
        expect(runReminderTick(second.db, now)).toHaveLength(0);
        const [row] = second.db.getDeliveriesByEvent(event.id);
        expect(row.status).toBe('delivered');
      } finally {
        await second.app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Джоба доставки — часть встроенного планировщика, а не пользовательская задача из CRUD.
 * Проверяется то, что видно снаружи: строка расписания одна, крон минутный, а работа (через
 * `triggerJob` — тот же путь, которым её зовёт крон) выдаёт всю просрочку за один проход.
 */
describe('Organizer Server: джоба доставки в планировщике (Шаг 8a.3)', () => {
  const MINUTE = 60_000;

  let server: Awaited<ReturnType<typeof createServer>>;

  // Автозапуск планировщика выключен: джобу регистрирует тест тем же публичным вызовом, что
  // и `createServer`, — так прогон не зависит от того, в какой момент его запустили.
  beforeEach(async () => {
    server = await createServer({ dbLocation: ':memory:', startScheduler: false });
  });

  afterEach(async () => {
    await server.app.close();
  });

  function tickJobs() {
    return server.scheduler.listJobs().filter((job) => job.action === REMINDER_TICK_ACTION);
  }

  it('регистрируется одной джобой с минутным расписанием, второй старт дубля не создаёт', () => {
    registerReminderDispatch(server.db, server.scheduler);
    expect(tickJobs()).toHaveLength(1);
    expect(tickJobs()[0].cronExpression).toBe(REMINDER_TICK_CRON);

    // Краснеет при: снятии поиска существующей джобы по `action` — `addJob` выдаёт новый `id`
    // на каждый вызов, поэтому каждый рестарт сервера добавлял бы ещё строку расписания,
    // и тик запускался бы N раз в минуту.
    registerReminderDispatch(server.db, server.scheduler);
    expect(tickJobs()).toHaveLength(1);
  });

  it('джоба выдаёт всю просрочку за один проход и не блокирует цикл событий', async () => {
    const job = registerReminderDispatch(server.db, server.scheduler);
    // Живой крон гасим: строки готовятся относительно реального «сейчас», и на границе минуты
    // крон забрал бы их раньше теста, сделав счётчики плавающими. Тик зовём тем же путём, что он.
    server.scheduler.stopAll();

    const now = Date.now();
    for (let index = 0; index < 100; index += 1) {
      const startTime = now - (index + 1) * MINUTE + 10 * MINUTE;
      server.db.createEvent({
        title: `Событие ${index}`,
        startTime,
        endTime: startTime + MINUTE,
        reminderMinutes: 10,
      });
    }
    const rowCount = () =>
      server.db
        .getEvents()
        .reduce((total, event) => total + server.db.getDeliveriesByEvent(event.id).length, 0);

    const timerDelay = new Promise<number>((resolve) => {
      const startedAt = Date.now();
      setTimeout(() => resolve(Date.now() - startedAt), 0);
    });

    await server.scheduler.triggerJob(job.id);

    const [delay, health] = await Promise.all([
      timerDelay,
      server.app.inject({ method: 'GET', url: '/health' }),
    ]);

    // Краснеет при: синхронном внешнем вызове внутри обработчика (`execSync`, `sleep`) — он держал бы
    // event loop, и таймер с нулевой задержкой сработал бы только после его завершения. Порог грубый
    // намеренно: ловится вред в сотни миллисекунд, а не работа с локальной SQLite (она синхронна по природе).
    expect(delay).toBeLessThan(200);
    expect(health.statusCode).toBe(200);
    expect(rowCount()).toBe(100);
    expect(
      server.db
        .getEvents()
        .every((event) =>
          server.db.getDeliveriesByEvent(event.id).every((row) => row.status === 'delivered')
        )
    ).toBe(true);

    // Краснеет при: снятии пометки «выдано» — второй проход выдал бы те же 100 срабатываний снова.
    await server.scheduler.triggerJob(job.id);
    expect(rowCount()).toBe(100);
  });
});
