import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/index.js';
import { requireToken } from '../src/auth.js';

describe('Organizer Server: Auth Security & Timing-Safe Verification (Шаг 7.0.1)', () => {
  const TEST_TOKEN = 'test-secret-token-32-chars-long!';
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    // В каждом тесте поднимаем изолированный экземпляр в памяти
    server = await createServer({ dbLocation: ':memory:', token: TEST_TOKEN });
  });

  afterEach(async () => {
    // Гарантированно освобождаем ресурсы Fastify и SQLite
    await server.app.close();
  });

  /**
   * TDD Case 1: Happy Path
   * Корректный токен должен успешно проходить через onRequest hook к хендлеру роута.
   */
  it('1. верный токен → 200', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-client-token': TEST_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  /**
   * TDD Case 2: Timing-Safe сравнение при равной длине
   * Проверяем, что даже когда длины строк совпадают, байты корректно верифицируются
   * и несовпадающий токен отклоняется со статусом 401.
   */
  it('2. неверный токен той же длины → 401', async () => {
    const wrongTokenSameLen = 'x'.repeat(TEST_TOKEN.length);
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-client-token': wrongTokenSameLen,
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Unauthorized');
  });

  /**
   * TDD Case 3: Защита от падения crypto.timingSafeEqual при разной длине буферов
   * Критический краевой случай: если передать в crypto.timingSafeEqual буферы разной длины,
   * Node.js выбросит исключение RangeError. Без предварительной проверки длины это
   * превратило бы 401 Unauthorized в 500 Internal Server Error, нарушая контракт API.
   */
  it('3. токен другой длины → 401, без исключения 500', async () => {
    // Токен короче ожидаемого
    const shortTokenRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-client-token': 'short',
      },
    });
    expect(shortTokenRes.statusCode).toBe(401);
    expect(JSON.parse(shortTokenRes.body).success).toBe(false);

    // Токен длиннее ожидаемого
    const longTokenRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-client-token': 'a'.repeat(TEST_TOKEN.length * 2),
      },
    });
    expect(longTokenRes.statusCode).toBe(401);
    expect(JSON.parse(longTokenRes.body).success).toBe(false);
  });

  /**
   * TDD Case 4: Отсутствие или пустое значение заголовка
   */
  it('4. пустой заголовок → 401', async () => {
    const noHeaderRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
    });
    expect(noHeaderRes.statusCode).toBe(401);
    expect(JSON.parse(noHeaderRes.body).success).toBe(false);

    const emptyHeaderRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-client-token': '',
      },
    });
    expect(emptyHeaderRes.statusCode).toBe(401);
    expect(JSON.parse(emptyHeaderRes.body).success).toBe(false);
  });

  /**
   * TDD Case 5: Публичный доступ к мониторингу
   * Роут /health не должен блокироваться хуком авторизации.
   */
  it('5. /health доступен без токена', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
  });

  /**
   * TDD Case 6: Чистая валидация конфигурации (Fail-Fast)
   * Проверяем, что парсер конфигурации отсекает пустые токены и пробельные строки.
   */
  it('6. валидация конфига без ORGANIZER_TOKEN → ошибка (requireToken)', () => {
    expect(() => requireToken({})).toThrowError(/ORGANIZER_TOKEN/);
    expect(() => requireToken({ ORGANIZER_TOKEN: '' })).toThrowError(/ORGANIZER_TOKEN/);
    expect(() => requireToken({ ORGANIZER_TOKEN: '   ' })).toThrowError(/ORGANIZER_TOKEN/);
    expect(requireToken({ ORGANIZER_TOKEN: 'valid-secret' })).toBe('valid-secret');
  });
});
