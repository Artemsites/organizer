import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/index.js';
import type { SyncPayload, SyncResult } from '@organizer/shared';
import { syncEventSchema, syncTaskSchema } from './schemas.js';

export async function syncRoutes(fastify: FastifyInstance, options: { db: Database }) {
  const { db } = options;

  // Протокол синхронизации состояния
  fastify.post('/api/v1/sync', async (request, reply) => {
    const payload = request.body as SyncPayload;
    if (!payload || !payload.clientId) {
      reply.status(400);
      return {
        success: false,
        error: 'clientId is required for sync',
        timestamp: Date.now(),
      };
    }

    const now = Date.now();

    // 1. Фиксируем активность клиента
    db.upsertClient({
      id: payload.clientId,
      status: 'online',
    });

    // 2. Применяем входящие изменения от клиента.
    // Best Practice: Per-Record Quarantine (карантин поштучно, не пакетом).
    // Одна кривая запись не роняет весь пакет: иначе один битый клиент блокирует
    // синхронизацию всех своих записей (Self-DoS). Отвергнута альтернатива «400 на весь
    // пакет» — она превращает чужую одну ошибку в потерю всех остальных данных пачки.
    // В БД уходит `parsed.data`, а не исходник: Zod в `strip()` срезает поля вне схемы,
    // и чужие системные атрибуты не подменят существующую строку по её `id`.
    // Счётчики отклонённых едут в ответе — клиент видит, что часть пачки не принята.
    let rejectedTasks = 0;
    let rejectedEvents = 0;

    if (payload.tasks && Array.isArray(payload.tasks)) {
      for (const task of payload.tasks) {
        const parsed = syncTaskSchema.safeParse(task);
        if (!parsed.success) {
          rejectedTasks++;
          continue;
        }
        db.upsertTask(parsed.data);
      }
    }

    if (payload.events && Array.isArray(payload.events)) {
      for (const event of payload.events) {
        const parsed = syncEventSchema.safeParse(event);
        if (!parsed.success) {
          rejectedEvents++;
          continue;
        }
        db.upsertEvent(parsed.data);
      }
    }

    // 3. Выбираем изменения сервера с момента lastSyncAt
    const lastSyncAt = payload.lastSyncAt || 0;
    const serverTasks = db.getTasksSince(lastSyncAt);
    const serverEvents = db.getEventsSince(lastSyncAt);

    const result: SyncResult = {
      serverTimestamp: now,
      tasks: serverTasks,
      events: serverEvents,
      backlog: [],
      rejectedTasks,
      rejectedEvents,
    };

    return {
      success: true,
      data: result,
      timestamp: now,
    };
  });

  // Список подключенных клиентов
  fastify.get('/api/v1/clients', async () => {
    const clients = db.getClients();
    return {
      success: true,
      data: clients,
      timestamp: Date.now(),
    };
  });
}
