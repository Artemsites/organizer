import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/index.js';
import { createTaskSchema, updateTaskSchema } from './schemas.js';

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Route Handler — функция-обработчик конкретного HTTP-метода и пути (эндпоинта).
 * - Request Payload / Body — полезная нагрузка запроса (тело в формате JSON).
 * - Safe Parsing — парсинг без выбрасывания исключений (Exceptions), возвращающий
 *   дискриминированное объединение (Tagged Union): `{ success: true, data } | { success: false, error }`.
 * - Mass Assignment Protection — передача строго `parsed.data` вместо исходного `request.body`
 *   гарантирует, что лишние поля отсечены на входе и не попадут в базу данных.
 */
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

  /**
   * POST /api/v1/tasks — Создание задачи.
   * 
   * Best Practice: Fail-Fast валидация с единым контрактом ошибок.
   * Если валидация не прошла, хендлер немедленно завершается со статусом 400 Bad Request,
   * предотвращая вызов БД.
   */
  fastify.post('/api/v1/tasks', async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        success: false,
        error: parsed.error.issues[0].message,
        timestamp: Date.now(),
      };
    }

    // Передаем очищенные данные (parsed.data), защищаясь от лишних полей
    const created = db.createTask(parsed.data);
    reply.status(201);
    return { success: true, data: created, timestamp: Date.now() };
  });

  /**
   * PATCH /api/v1/tasks/:id — Частичное обновление задачи.
   * 
   * Best Practice:
   * 1. Валидация входных данных ДО обращения к БД. Если передан невалидный статус (например, 'lol')
   *    или пустой объект {}, запрос отклоняется без побочных эффектов.
   * 2. Идемпотентность и целостность: БД не меняется, если валидация упала.
   */
  fastify.patch('/api/v1/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        success: false,
        error: parsed.error.issues[0].message,
        timestamp: Date.now(),
      };
    }

    const updated = db.updateTask(id, parsed.data);
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
