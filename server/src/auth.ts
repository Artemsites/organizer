import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

// Фолбэк-секрет предназначен исключительно для изолированных unit/integration тестов,
// чтобы тестам не требовалось обязательно передавать переменную окружения.
export const DEFAULT_TOKEN = 'organizer-secret-token';

/**
 * Best Practice: Fail-Fast конфигурация через чистую функцию.
 * 
 * Почему так:
 * 1. Валидация вынесена в чистую функцию, принимающую словарь окружения (DI - Dependency Injection).
 *    Это позволяет легко тестировать краевые случаи (пустая строка, пробелы, отсутствие)
 *    в unit-тестах без вызова process.exit и без мутации глобального process.env.
 * 2. Принцип Fail-Fast: сервис не должен запускаться в полу-рабочем или небезопасном состоянии,
 *    если отсутствует обязательный секрет.
 */
export function requireToken(env: Record<string, string | undefined> = process.env): string {
  const token = env.ORGANIZER_TOKEN;
  if (!token || token.trim() === '') {
    throw new Error('ORGANIZER_TOKEN is required');
  }
  return token;
}

/**
 * Best Practice: Защита от атак по времени (Timing Attacks) при проверке секретов.
 * 
 * Теория уязвимости:
 * Стандартное сравнение строк (`===` или `!==`) в JavaScript оптимизировано:
 * движок V8 сравнивает символы по порядку и останавливается (short-circuit) на первом
 * несовпадающем символе. Это приводит к разнице во времени выполнения в доли наносекунд.
 * Злоумышленник, замеряя статистику времени ответа по сети, может посимвольно подобрать токен.
 * 
 * Решение:
 * `crypto.timingSafeEqual` гарантирует постоянное время проверки (O(N)),
 * сравнивая все байты вне зависимости от того, где обнаружено несовпадение.
 * 
 * Важный подводный камень Node.js crypto:
 * `crypto.timingSafeEqual(bufA, bufB)` выбрасывает исключение `RangeError`,
 * если длины буферов отличаются! Если не проверить равенство длин заранее,
 * невалидный токен чужой длины вызовет ошибку 500 вместо ожидаемого 401.
 */
export function verifyToken(clientToken: string | string[] | undefined, expectedToken: string): boolean {
  if (typeof clientToken !== 'string' || !expectedToken) {
    return false;
  }

  const clientBuffer = Buffer.from(clientToken);
  const expectedBuffer = Buffer.from(expectedToken);

  // Обязательная проверка длины перед вызовом crypto.timingSafeEqual,
  // иначе метод выбросит RangeError: Input buffers must have the same byte length
  if (clientBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(clientBuffer, expectedBuffer);
}

export interface AuthHookOptions {
  maxFailures?: number;
  windowMs?: number;
}

/**
 * Best Practice: Фабрика хуков (Hook Factory) с защитой от подбора (Anti-Brute-Force Rate Limiting).
 * 
 * 1. Инкапсуляция: фабрика замыкает `expectedToken` и локальную in-memory Map счетчиков попыток.
 * 2. Rate Limiting по IP: если с одного IP зафиксировано >= maxFailures ошибок авторизации
 *    в рамках окна windowMs, последующие запросы немедленно отклоняются со статусом
 *    HTTP 429 Too Many Requests, предотвращая бесконечный перебор секретов скриптами.
 * 3. Happy Path сброс: при успешной авторизации счетчик ошибок очищается.
 */
export function createAuthHook(expectedToken: string, options: AuthHookOptions = {}) {
  const maxFailures = options.maxFailures ?? 5;
  const windowMs = options.windowMs ?? 60_000;
  const failureMap = new Map<string, { count: number; resetAt: number }>();

  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Публичный эндпоинт healthcheck не требует авторизации (liveness probe)
    if (request.url.startsWith('/health')) {
      return;
    }

    const ip = request.ip || 'unknown';
    const now = Date.now();
    const record = failureMap.get(ip);

    // 1. Проверка лимита неудач (Rate Limiter)
    if (record && now < record.resetAt && record.count >= maxFailures) {
      reply.status(429).send({
        success: false,
        error: 'Too many failed authentication attempts. Try again later.',
        timestamp: now,
      });
      return;
    }

    const clientToken = request.headers['x-client-token'];
    if (!verifyToken(clientToken, expectedToken)) {
      // Инкрементируем счетчик неудачных попыток
      if (!record || now >= record.resetAt) {
        failureMap.set(ip, { count: 1, resetAt: now + windowMs });
      } else {
        record.count++;
      }

      reply.status(401).send({
        success: false,
        error: 'Unauthorized: invalid or missing x-client-token',
        timestamp: now,
      });
      return; // Защитный ранний возврат
    }

    // При успешной авторизации сбрасываем историю неудач для данного IP
    if (record) {
      failureMap.delete(ip);
    }
  };
}

