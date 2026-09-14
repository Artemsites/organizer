import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/index.js';
import type { CreateTaskDto, UpdateTaskDto } from '@organizer/shared';

export async function taskRoutes(fastify: FastifyInstance, options: { db: Database }) {
  const { db } = options;

  // Получить список задач
  fastify.get('/api/v1/tasks', async (request) => {
    const query = request.query as { status?: string };
    const tasks = db.getTasks(query.status);
    return {
      success: true,
      data: tasks,
      timestamp: Date.now(),
    };
  });

  // Получить задачу по ID
  fastify.get('/api/v1/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = db.getTaskById(id);
    if (!task) {
      reply.status(404);
      return { success: false, error: 'Task not found', timestamp: Date.now() };
    }
    return { success: true, data: task, timestamp: Date.now() };
  });

  // Создать задачу
  fastify.post('/api/v1/tasks', async (request, reply) => {
    const body = request.body as CreateTaskDto;
    if (!body || !body.title) {
      reply.status(400);
      return { success: false, error: 'Title is required', timestamp: Date.now() };
    }
    const created = db.createTask(body);
    reply.status(201);
    return { success: true, data: created, timestamp: Date.now() };
  });

  // Обновить задачу
  fastify.patch('/api/v1/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateTaskDto;
    const updated = db.updateTask(id, body);
    if (!updated) {
      reply.status(404);
      return { success: false, error: 'Task not found', timestamp: Date.now() };
    }
    return { success: true, data: updated, timestamp: Date.now() };
  });

  // Удалить задачу
  fastify.delete('/api/v1/tasks/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.deleteTask(id);
    return { success: true, timestamp: Date.now() };
  });
}
