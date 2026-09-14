import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/index.js';
import type { SyncPayload, SyncResult } from '@organizer/shared';

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

    // 2. Применяем входящие изменения от клиента
    if (payload.tasks && Array.isArray(payload.tasks)) {
      for (const task of payload.tasks) {
        db.upsertTask(task);
      }
    }

    if (payload.events && Array.isArray(payload.events)) {
      for (const event of payload.events) {
        db.upsertEvent(event);
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
