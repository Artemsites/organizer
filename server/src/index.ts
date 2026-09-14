import Fastify from 'fastify';
import { Database } from './db/index.js';
import { authHook } from './auth.js';
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
}

export async function createServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: false });
  const db = new Database(options.dbLocation || ':memory:');
  const scheduler = new Scheduler(db);

  if (options.startScheduler !== false) {
    scheduler.start();
  }

  // Healthcheck без авторизации
  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Авторизация для всех остальных эндпоинтов
  app.addHook('onRequest', authHook);

  // Регистрация маршрутов
  await app.register(taskRoutes, { db });
  await app.register(eventRoutes, { db });
  await app.register(jobRoutes, { scheduler });
  await app.register(syncRoutes, { db });
  await app.register(pluginRoutes);

  // Метод закрытия ресурсов
  app.addHook('onClose', () => {
    scheduler.stopAll();
    db.close();
  });

  return { app, db, scheduler };
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const dbPath = process.env.DB_PATH || 'organizer.db';
  const { app } = await createServer({ dbLocation: dbPath });
  const port = Number(process.env.PORT) || 3000;
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Organizer Server running at ${address}`);
  });
}
