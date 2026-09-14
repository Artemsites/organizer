import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/index.js';
import type { CreateEventDto } from '@organizer/shared';

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

  // Создать событие
  fastify.post('/api/v1/events', async (request, reply) => {
    const body = request.body as CreateEventDto;
    if (!body || !body.title || body.startTime === undefined || body.endTime === undefined) {
      reply.status(400);
      return {
        success: false,
        error: 'title, startTime, and endTime are required',
        timestamp: Date.now(),
      };
    }
    const created = db.createEvent(body);
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
