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

/**
 * Best Practice: Фабрика хуков (Hook Factory) и явное прерывание выполнения.
 * 
 * 1. Инкапсуляция: фабрика замыкает `expectedToken`, избегая глобального состояния.
 * 2. В Fastify вызов `reply.send()` в хуке `onRequest` останавливает цепочку роутинга,
 *    однако явный `return` защищает от случайного продолжения выполнения кода
 *    внутри самого хука ниже по тексту (Defensive Programming).
 */
export function createAuthHook(expectedToken: string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Публичный эндпоинт healthcheck не требует авторизации (liveness probe)
    if (request.url.startsWith('/health')) {
      return;
    }

    const clientToken = request.headers['x-client-token'];
    if (!verifyToken(clientToken, expectedToken)) {
      reply.status(401).send({
        success: false,
        error: 'Unauthorized: invalid or missing x-client-token',
        timestamp: Date.now(),
      });
      return; // Защитный ранний возврат
    }
  };
}

