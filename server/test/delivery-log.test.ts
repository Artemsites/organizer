import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "../src/index.js";
import { DEFAULT_TOKEN } from "../src/auth.js";
import { DELIVERY_RETENTION_MS } from "../src/db/index.js";

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Idempotency Key — ключ (здесь пара event + fire_at), повторная операция с которым
 *   не создаёт нового эффекта. Дедуп на уровне СУБД переживает рестарт процесса.
 * - UNIQUE Constraint — ограничение целостности: СУБД отклоняет дубль исключением,
 *   а не прикладной код проверкой (check-then-insert — Race Condition / TOCTOU).
 * - ON DELETE CASCADE — дочерние строки удаляются вместе с родителем одним DELETE,
 *   сирот (orphaned rows) не остаётся, второй вызов из роута не нужен.
 * - Retention (срок хранения) + Pruning (чистка): выданные строки старше срока удаляются,
 *   иначе таблица растёт без границ в обход hard cap Шага 7.0.3.
 *
 * Урок Шага 7b.1: имя теста — обещание. Под каждым тестом указано, какое изменение
 * кода обязано его покраснить. Если тест зелёный после такого изменения — он ложно-зелёный.
 */
describe("Organizer Server: Delivery Log journal", () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    server = await createServer({ dbLocation: ":memory:" });
  });

  afterEach(async () => {
    await server.app.close();
  });

  function makeEvent() {
    const now = Date.now();
    // Без `reminderMinutes`: этот набор проверяет журнал доставки сам по себе, а событие с
    // интервалом напоминания теперь планирует строку ещё при создании (Шаг 8a.3) — тогда счётчики
    // ниже считали бы чужие строки. Планирование проверяется в `reminders-dispatch.test.ts`.
    return server.db.createEvent({
      title: "Встреча",
      startTime: now + 3_600_000,
      endTime: now + 7_200_000,
    });
  }

  /**
   * Обещание: дубль пары (событие, момент) отклоняет хранилище.
   * Краснеет при: снятии UNIQUE-индекса idx_delivery_log_event_fire в schema.ts.
   */
  it("вторая запись той же пары (event, fire_at) отклоняется хранилищем (UNIQUE)", () => {
    const event = makeEvent();
    const fireAt = Date.now() + 600_000;

    server.db.scheduleDelivery(event.id, fireAt);

    // Best Practice: Negative Testing — проверяем отказ, а не только happy path.
    // Регулярка /UNIQUE/i привязывает тест к механизму (ограничение СУБД),
    // а не к любому исключению: прикладная проверка с другим текстом его не позеленит.
    expect(() => server.db.scheduleDelivery(event.id, fireAt)).toThrow(
      /UNIQUE/i,
    );
  });

  /**
   * Обещание: удаление события уносит его строки журнала каскадом.
   * Краснеет при: снятии ON DELETE CASCADE или выключении foreign_keys в schema.ts.
   * Удаляем через HTTP DELETE (как требует приёмка), а не прямым вызовом db:
   * роут обязан обходиться без отдельного вызова чистки журнала.
   */
  it("удаление события через DELETE /api/v1/events/:id уносит строки журнала", async () => {
    const event = makeEvent();
    const now = Date.now();
    server.db.scheduleDelivery(event.id, now + 600_000);
    server.db.scheduleDelivery(event.id, now + 1_200_000);
    expect(server.db.getDeliveriesByEvent(event.id)).toHaveLength(2);

    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/events/${event.id}`,
      headers: { "x-client-token": DEFAULT_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    expect(server.db.getDeliveriesByEvent(event.id)).toHaveLength(0);
  });

  /**
   * Обещание: чистка удаляет только выданные старше retention.
   * Краснеет при: удалении условия status = 'delivered' (сотрётся невыданный backlog
   * догона) или снятии порога delivered_at < cutoff (сотрётся свежее).
   */
  it("чистка удаляет выданные старше retention, хранит свежие и все невыданные", () => {
    const event = makeEvent();
    const now = Date.now();
    const cutoff = now - DELIVERY_RETENTION_MS;

    // Выданная давно: delivered_at старше срока — кандидат на удаление.
    const old = server.db.scheduleDelivery(event.id, cutoff - 3_600_000);
    server.db.markDelivered(old.id, cutoff - 1_000);

    // Выданная только что: моложе срока — остаётся для Last-Event-ID-переподключений.
    const fresh = server.db.scheduleDelivery(event.id, now - 1_000);
    server.db.markDelivered(fresh.id, now);

    // Невыданная, даже старая: backlog догона после простоя (Шаг 8a.3) — удалять запрещено.
    const pending = server.db.scheduleDelivery(event.id, cutoff - 7_200_000);

    const deleted = server.db.pruneDeliveredOlderThan(cutoff);

    expect(deleted).toBe(1);
    const rest = server.db.getDeliveriesByEvent(event.id).map((d) => d.id);
    expect(rest).not.toContain(old.id);
    expect(rest).toContain(fresh.id);
    expect(rest).toContain(pending.id);
  });

  /**
   * Обещание: повторная пометка «выдано» — no-op (идемпотентная запись).
   * Краснеет при: снятии условия WHERE status = 'pending' в markDelivered —
   * тогда второй вызов перезапишет delivered_at и сломает «ровно один раз» Шага 8a.3.
   */
  it("повторная пометка выданной строки — no-op", () => {
    const event = makeEvent();
    const row = server.db.scheduleDelivery(event.id, Date.now() + 600_000);

    expect(server.db.markDelivered(row.id)).toBe(true);
    expect(server.db.markDelivered(row.id)).toBe(false);

    const [after] = server.db.getDeliveriesByEvent(event.id);
    expect(after.status).toBe("delivered");
  });
});
