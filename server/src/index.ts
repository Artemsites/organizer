import Fastify from 'fastify';
import { Database } from './db/index.js';
import { createAuthHook, requireToken, DEFAULT_TOKEN } from './auth.js';
import { taskRoutes } from './routes/tasks.js';
import { eventRoutes } from './routes/events.js';
import { jobRoutes } from './routes/jobs.js';
import { syncRoutes } from './routes/sync.js';
import { pluginRoutes, registerServerPlugin } from './routes/plugins.js';
import { Scheduler } from './scheduler/index.js';

export { registerServerPlugin };

export interface ServerOptions {
  dbLocation?: string;
  startScheduler?: boolean;
  token?: string;
  maxTasks?: number;
  maxAuthFailures?: number;
  failureWindowMs?: number;
  logger?: boolean | object;
}

/**
 * Best Practice: Фабрика приложения (Application Factory) для тестируемости.
 * 
 * Создание экземпляра сервера вынесено в фабрику `createServer`, принимающую опции:
 * 1. Инъекция зависимостей: в тестах можно передать `dbLocation: ':memory:'` и изолированный `token`.
 * 2. Тесты через fastify.inject выполняются без открытия сетевых сокетов (zero-port listening),
 *    что ускоряет запуск сотен тестов в параллели и исключает конфликты занятых портов (EADDRINUSE).
 * 3. Hardening:
 *    - Защита от перебора токена (Anti-Brute-Force Rate Limiting в createAuthHook).
 *    - Защита диска от замусоривания бесконечными задачами (maxTasks hard cap в taskRoutes).
 *    - Защита от утечки секретов в логи (CWE-532 Log Redaction через Fastify/Pino redact).
 */
export async function createServer(options: ServerOptions = {}) {
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  const token = options.token ?? process.env.ORGANIZER_TOKEN ?? (isTest ? DEFAULT_TOKEN : undefined);
  if (!token) {
    throw new Error('ORGANIZER_TOKEN is required to start server');
  }

  // Конфигурация логгера с автоматическим скрытием заголовка x-client-token (CWE-532)
  // По умолчанию Fastify не логирует headers. Чтобы заголовки попадали в лог
  // и маскировались Pino redact, явно сериализуем req.headers.
  let loggerConfig: boolean | object = false;
  if (options.logger) {
    const customOptions = typeof options.logger === 'object' ? options.logger : {};
    loggerConfig = {
      level: 'info',
      ...customOptions,
      serializers: {
        req(req: any) {
          return {
            method: req.method,
            url: req.url,
            headers: req.headers,
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
        ...(customOptions as any).serializers,
      },
      redact: ['req.headers["x-client-token"]', 'req.headers.x-client-token'],
    };
  }

  const app = Fastify({ logger: loggerConfig });
  const db = new Database(options.dbLocation || ':memory:');
  const scheduler = new Scheduler(db);

  if (options.startScheduler !== false) {
    scheduler.start();
  }

  // Healthcheck без авторизации (Liveness Probe для оркестраторов и систем мониторинга)
  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Авторизация для всех остальных эндпоинтов через timing-safe хук с rate-лимитом неудач
  app.addHook(
    'onRequest',
    createAuthHook(token, {
      maxFailures: options.maxAuthFailures,
      windowMs: options.failureWindowMs,
    })
  );

  // Регистрация маршрутов с передачей лимита задач
  await app.register(taskRoutes, { db, maxTasks: options.maxTasks });
  await app.register(eventRoutes, { db });
  await app.register(jobRoutes, { scheduler });
  await app.register(syncRoutes, { db });
  await app.register(pluginRoutes);

  // Метод закрытия ресурсов: предотвращение утечек дескрипторов БД и интервалов планировщика
  app.addHook('onClose', () => {
    scheduler.stopAll();
    db.close();
  });

  return { app, db, scheduler };
}

/**
 * Best Practice: Разделение точки сборки и точки запуска (Entrypoint vs Module).
 * Блок `if` выполняется только при прямом запуске процесса (`node src/index.js`),
 * но не при импорте в тестах.
 */
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  // 1. Fail-Fast валидация конфигурации перед инициализацией
  try {
    requireToken(process.env);
  } catch (err) {
    console.error(`Configuration error: ${(err as Error).message}`);
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH || 'organizer.db';
  const { app } = await createServer({ dbLocation: dbPath });
  const port = Number(process.env.PORT) || 3000;

  /**
   * Best Practice: Принцип наименьших привилегий для сетевых интерфейсов (Least Privilege).
   * 
   * '0.0.0.0' (INADDR_ANY) слушает все доступные сетевые интерфейсы (включая локальную Wi-Fi сеть).
   * '127.0.0.1' (loopback) принимает пакеты исключительно внутри локальной ОС.
   * Открытие наружу должно производиться осознанно через переменную окружения `HOST=0.0.0.0`.
   */
  const host = process.env.HOST ?? '127.0.0.1';
  app.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Organizer Server running at ${address}`);
  });
}
