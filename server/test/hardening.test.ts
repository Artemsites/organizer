import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import { createServer } from "../src/index.js";

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Hardening — усиление защиты системы, закрытие потенциальных векторов атак.
 * - Brute-Force Protection — защита от подбора секретов методом перебора.
 * - Rate Limiting (429 Too Many Requests) — ограничение допустимой частоты обращений.
 * - Hard Cap — жесткий верхний предел (потолок записей) для защиты от переполнения диска (Disk Exhaustion).
 * - Log Redaction (CWE-532) — автоматическое маскирование конфиденциальных заголовков/секретов в логах.
 * - Defense in Depth — принцип многоуровневой (эшелонированной) защиты приложения.
 */
describe("Organizer Server: API Hardening & Anti-Abuse (Шаг 7.0.3)", () => {
  const CORRECT_TOKEN = "hardening-test-secret-token!";

  /**
   * TDD Case 1: Rate limit перебора неверного токена.
   * После N неудачных попыток с одного IP сервис должен возвращать 429 Too Many Requests,
   * блокируя скрипты автоматического перебора.
   */
  it("1. N+1 неверных попыток подряд → 429 Too Many Requests", async () => {
    const server = await createServer({
      dbLocation: ":memory:",
      token: CORRECT_TOKEN,
      maxAuthFailures: 3, // Разрешаем 3 ошибки
    });

    try {
      // Первые 3 попытки с неверным токеном возвращают 401 Unauthorized
      for (let i = 0; i < 3; i++) {
        const res = await server.app.inject({
          method: "GET",
          url: "/api/v1/tasks",
          headers: { "x-client-token": "wrong-token" },
        });
        expect(res.statusCode).toBe(401);
      }

      // 4-я попытка (N + 1) блокируется rate-лимитером со статусом 429
      const blockedRes = await server.app.inject({
        method: "GET",
        url: "/api/v1/tasks",
        headers: { "x-client-token": "wrong-token" },
      });

      expect(blockedRes.statusCode).toBe(429);
      const body = JSON.parse(blockedRes.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain("Too many failed");
    } finally {
      await server.app.close();
    }
  });

  /**
   * TDD Case 2: Запросы с корректным токеном не блокируются.
   * Белый список (Happy Path): легитимный клиент не должен получать 429.
   */
  it("2. лимит не срабатывает на верном токенe", async () => {
    const server = await createServer({
      dbLocation: ":memory:",
      token: CORRECT_TOKEN,
      maxAuthFailures: 3,
    });

    try {
      const res = await server.app.inject({
        method: "GET",
        url: "/api/v1/tasks",
        headers: { "x-client-token": CORRECT_TOKEN },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    } finally {
      await server.app.close();
    }
  });

  /**
   * TDD Case 3: Превышение потолка задач (Hard Cap).
   * Защита дискового пространства ПК: при достижении maxTasks (например, 2 в тесте, 2500 в проде)
   * последующие попытки создания задач отклоняются с ошибкой 400.
   */
  it("3. превышение потолка задач → 400 и запись не создается в БД", async () => {
    const server = await createServer({
      dbLocation: ":memory:",
      token: CORRECT_TOKEN,
      maxTasks: 2, // Ограничение в 2 задачи для проверки краевого случая
    });

    try {
      // 1-я задача успешно создана
      const res1 = await server.app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        headers: { "x-client-token": CORRECT_TOKEN },
        payload: { title: "Задача 1" },
      });
      expect(res1.statusCode).toBe(201);

      // 2-я задача успешно создана (достигнут лимит 2)
      const res2 = await server.app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        headers: { "x-client-token": CORRECT_TOKEN },
        payload: { title: "Задача 2" },
      });
      expect(res2.statusCode).toBe(201);

      // 3-я задача отклоняется
      const res3 = await server.app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        headers: { "x-client-token": CORRECT_TOKEN },
        payload: { title: "Задача 3 (лишняя)" },
      });

      expect(res3.statusCode).toBe(400);
      const body = JSON.parse(res3.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain("Task limit reached");

      // Физическая проверка БД: в таблице ровно 2 записи
      expect(server.db.getTasksCount()).toBe(2);
    } finally {
      await server.app.close();
    }
  });

  /**
   * TDD Case 4: Автоматическое маскирование секрета в логах (Log Redaction).
   * Проверяем, что при включенном логгере заголовок x-client-token маскируется ([Redacted])
   * и реальный секретный токен не утекает в поток вывода.
   */
  it("4. токен не появляется в выводе логгера при включенном логировании (redact)", async () => {
    let capturedLogs = "";
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLogs += chunk.toString();
        callback();
      },
    });

    const server = await createServer({
      dbLocation: ":memory:",
      token: CORRECT_TOKEN,
      logger: {
        level: "info",
        stream: logStream,
      },
    });

    try {
      await server.app.inject({
        method: "GET",
        url: "/api/v1/tasks",
        headers: { "x-client-token": CORRECT_TOKEN },
      });

      // Логи должны содержать факт вызова эндпоинта
      expect(capturedLogs).toContain("/api/v1/tasks");

      // Но секретный токен НЕ должен присутствовать в открытом виде
      expect(capturedLogs).not.toContain(CORRECT_TOKEN);

      // Заголовок должен быть помечен как [Redacted]
      expect(capturedLogs).toContain("[Redacted]");
    } finally {
      await server.app.close();
    }
  });
});
