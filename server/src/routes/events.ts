import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/index.js';
import { createEventSchema } from './schemas.js';

export async function eventRoutes(fastify: FastifyInstance, options: { db: Database }) {
  const { db } = options;

  // Получить список событий
  fastify.get('/api/v1/events', async () => {
    const events = db.getEvents();
    return {
      success: true,
      data: events,
      timestamp: Date.now(),
    };
  });

  /**
   * POST /api/v1/events — Создание события.
   *
   * Почему валидация стоит здесь, а не в хранилище: `db.createEvent` — тонкая запись в SQLite,
   * его зовут и синхронизация, и скрипты; проверять контракт в каждом вызывающем — дублирование,
   * которое разъедется. Граница API принимает недоверенный ввод (Untrusted Input) один раз
   * и дальше по системе идёт уже проверенный объект.
   *
   * Почему в БД уходит `parsed.data`, а не `request.body`: Zod в режиме `strip()` вырезает поля,
   * которых нет в схеме. Иначе клиент диктует серверу `id` и `createdAt` (Mass Assignment / Over-posting):
   * своим `id` он подменяет системный, а тот же `id` в `/api/v1/sync` ложится в `upsertEvent`
   * и перезаписывает чужую строку — след чужого клиента вместо своей записи.
   *
   * Почему проверка вынесена в `schemas.ts`, а не оставлена строкой «title не пустой» тут:
   * второй способ валидации в проекте — второй источник истины (SSoT). Схемы задач уже лежат там,
   * и расхождение двух подходов обнаруживается только на проде.
   */
  fastify.post('/api/v1/events', async (request, reply) => {
    const parsed = createEventSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        success: false,
        error: parsed.error.issues[0].message,
        timestamp: Date.now(),
      };
    }

    const created = db.createEvent(parsed.data);
    reply.status(201);
    return { success: true, data: created, timestamp: Date.now() };
  });

  // Удалить событие
  fastify.delete('/api/v1/events/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.deleteEvent(id);
    return { success: true, timestamp: Date.now() };
  });
}
