import type { FastifyInstance } from 'fastify';
import type { Scheduler } from '../scheduler/index.js';

export async function jobRoutes(fastify: FastifyInstance, options: { scheduler: Scheduler }) {
  const { scheduler } = options;

  // Список всех задач планировщика
  fastify.get('/api/v1/jobs', async () => {
    const jobs = scheduler.listJobs();
    return {
      success: true,
      data: jobs,
      timestamp: Date.now(),
    };
  });

  // Создать новую задачу
  fastify.post('/api/v1/jobs', async (request, reply) => {
    const body = request.body as {
      name: string;
      cronExpression: string;
      target?: 'server' | 'client';
      action: string;
      params?: Record<string, unknown>;
    };

    if (!body || !body.name || !body.cronExpression || !body.action) {
      reply.status(400);
      return {
        success: false,
        error: 'name, cronExpression, and action are required',
        timestamp: Date.now(),
      };
    }

    const created = scheduler.addJob(body);
    reply.status(201);
    return {
      success: true,
      data: created,
      timestamp: Date.now(),
    };
  });

  // Запустить задачу немедленно
  fastify.post('/api/v1/jobs/:id/trigger', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await scheduler.triggerJob(id);
    if (!ok) {
      reply.status(404);
      return { success: false, error: 'Job not found', timestamp: Date.now() };
    }
    return { success: true, timestamp: Date.now() };
  });

  // Удалить задачу
  fastify.delete('/api/v1/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    scheduler.removeJob(id);
    return { success: true, timestamp: Date.now() };
  });
}
