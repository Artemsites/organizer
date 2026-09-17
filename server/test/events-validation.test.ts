import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "../src/index.js";
import { DEFAULT_TOKEN } from "../src/auth.js";
import { MAX_REMINDER_MINUTES } from "../src/routes/schemas.js";

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Contract Test — проверка контракта эндпоинта: код ответа и тело. Внутренности роута не трогаем
 *   (Black-Box): тест переживёт рефакторинг, пока контракт прежний. Шпионы на приватные вызовы
 *   (White-Box / Brittle Test) не используем.
 * - Boundary Validation — проверка недоверенного ввода (Untrusted Input) на границе системы.
 * - Mass Assignment / Over-posting — попытка клиента перетереть системные поля (`id`, `createdAt`).
 * - Domain Invariant (инвариант предметной области) — «конец события не раньше начала».
 * - Negative Testing — проверяем отказ (400) и отсутствие побочного эффекта в хранилище
 *   (State Preservation: неудачный запрос не мутирует БД).
 *
 * Урок Шага 7b.1: имя теста — обещание, а проверка — тело. Под каждым тестом указано, какое изменение
 * кода обязано его покраснить. Зелёный тест после такого изменения — ложно-зелёный, и шаг не принят.
 * Пункт приёмки «валидация событий и задач сделана одним подходом» тестом не покрывается: это свойство
 * кода, а не наблюдаемое поведение. Он проверяется чтением `routes/events.ts` и `routes/tasks.ts`.
 */
describe("Organizer Server: Events input validation", () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    server = await createServer({ dbLocation: ":memory:" });
  });

  afterEach(async () => {
    await server.app.close();
  });

  function createEvent(payload: unknown) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { "x-client-token": DEFAULT_TOKEN },
      payload,
    });
  }

  function validEvent() {
    const now = Date.now();
    return {
      title: "Встреча",
      startTime: now + 3_600_000,
      endTime: now + 7_200_000,
      reminderMinutes: 10,
    };
  }

  /**
   * Обещание: системные поля выдают сервер и БД, а не тело запроса.
   * Краснеет при: передаче `request.body` в `db.createEvent` вместо `parsed.data`
   * (тогда чужой `id`/`createdAt` попадут в ответ и в хранилище), либо при добавлении
   * `id` и `createdAt` в `createEventSchema` как принимаемых полей.
   */
  it("лишние поля id и createdAt из тела не доезжают до хранилища", async () => {
    const res = await createEvent({
      ...validEvent(),
      id: "attacker-supplied-id",
      createdAt: 1,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.id).not.toBe("attacker-supplied-id");
    expect(body.data.createdAt).not.toBe(1);

    const stored = server.db.getEvents();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(body.data.id);
    expect(stored[0].createdAt).not.toBe(1);
  });

  /**
   * Обещание: инвариант «конец не раньше начала» держится на границе API.
   * Краснеет при: снятии `.refine()` в `createEventSchema` — событие создастся с 201.
   */
  it("событие с концом раньше начала отклоняется, в базе ничего не создано", async () => {
    const start = Date.now() + 3_600_000;
    const res = await createEvent({
      title: "Встреча наоборот",
      startTime: start,
      endTime: start - 1,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
    expect(server.db.getEvents()).toHaveLength(0);
  });

  /**
   * Обещание: заголовок сверх контрактной длины не доезжает до БД.
   * Краснеет при: снятии `.max(MAX_EVENT_TITLE_LENGTH)` — 201 вместо 400, в БД ляжет 10 000 символов.
   */
  it("заголовок в 10 000 символов отклоняется, в базе ничего не создано", async () => {
    const res = await createEvent({ ...validEvent(), title: "x".repeat(10_000) });

    expect(res.statusCode).toBe(400);
    expect(server.db.getEvents()).toHaveLength(0);
  });

  /**
   * Обещание: дробная метка времени отклоняется — она ломает арифметику `fire_at` в шаге 8a.3.
   * Краснеет при: снятии `.int()` у `startTime`.
   */
  it("дробная метка времени отклоняется, в базе ничего не создано", async () => {
    const res = await createEvent({ ...validEvent(), startTime: 1_700_000_000_000.5 });

    expect(res.statusCode).toBe(400);
    expect(server.db.getEvents()).toHaveLength(0);
  });

  /**
   * Обещание: интервал напоминания ограничен сверху сроком хранения журнала и снизу нулём.
   * Краснеет при: снятии `.max(MAX_REMINDER_MINUTES)` (событие создастся) или `.min(0)`
   * (отрицательный интервал уедет в расчёт момента срабатывания).
   */
  it("интервал напоминания за границами отклоняется, в базе ничего не создано", async () => {
    const tooLate = await createEvent({
      ...validEvent(),
      reminderMinutes: MAX_REMINDER_MINUTES + 1,
    });
    const negative = await createEvent({ ...validEvent(), reminderMinutes: -1 });

    expect(tooLate.statusCode).toBe(400);
    expect(negative.statusCode).toBe(400);
    expect(server.db.getEvents()).toHaveLength(0);
  });

  /**
   * Обещание: валидные поля схема не теряет — «строгая валидация» не должна вырезать законное.
   * Краснеет при: объявлении `allDay`/`reminderMinutes` вне схемы (strip уберёт их молча)
   * или при отвержении валидного ввода.
   */
  it("валидное событие сохраняется вместе с allDay и интервалом напоминания", async () => {
    const res = await createEvent({ ...validEvent(), allDay: true });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.reminderMinutes).toBe(10);
    expect(body.data.allDay).toBe(true);

    const stored = server.db.getEvents();
    expect(stored).toHaveLength(1);
    expect(stored[0].reminderMinutes).toBe(10);
    expect(stored[0].allDay).toBe(true);
  });
});
