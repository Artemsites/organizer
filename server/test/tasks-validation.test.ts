import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/index.js';
import { DEFAULT_TOKEN } from '../src/auth.js';

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Happy Path — сценарий выполнения программы при полностью валидных входных данных.
 * - Edge Case — граничный/краевой случай (пустая строка, пробелы, null, экстремальные значения).
 * - Regression Testing — проверка того, что ранее работавшая функциональность не сломалась после изменений.
 * - Negative Testing — тестирование реакции системы на некорректные или вредоносные входные данные.
 * - Idempotency & State Preservation — гарантия, что неудачная операция не мутирует состояние системы.
 */
describe('Organizer Server: Tasks Input Validation & Sanitization (Шаг 7.0.2)', () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    server = await createServer({ dbLocation: ':memory:' });
  });

  afterEach(async () => {
    await server.app.close();
  });

  /**
   * 1. «POST без title → 400»
   * Поле title является обязательным первичным атрибутом задачи.
   */
  it('1. POST без title → 400', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        description: 'Описание без заголовка',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  /**
   * 2. «POST с title: '   ' → 400»
   * Sanitization + Min Length check.
   * Строка только из whitespace-символов не должна считаться валидным заголовком.
   */
  it('2. POST с title: "   " → 400', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        title: '   ',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('empty');
  });

  /**
   * 3. «POST с status: 'lol' → 400»
   * Enum constraint validation.
   * Защита БД от сохранения недопустимых статусов.
   */
  it('3. POST с status: "lol" → 400', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        title: 'Задача с некорректным статусом',
        status: 'lol',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  /**
   * 4. «POST с dueDate: 'вчера' → 400»
   * Type Safety validation.
   * dueDate должен быть положительным целым числом (UNIX timestamp в миллисекундах).
   */
  it('4. POST с dueDate: "вчера" → 400', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        title: 'Задача со строковой датой',
        dueDate: 'вчера',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  /**
   * 5. «PATCH { status: 'lol' } → 400 и db.getTaskById() возвращает прежнее значение»
   * State Preservation (Сохранение состояния).
   * Если валидация частичного обновления не прошла, база данных НЕ должна быть модифицирована.
   */
  it('5. PATCH { status: "lol" } → 400 и db.getTaskById() возвращает прежнее значение', async () => {
    // 1. Создаем начальную задачу
    const initial = server.db.createTask({
      title: 'Исходная задача',
      priority: 'high',
    });

    // 2. Пытаемся передать невалидный статус
    const patchRes = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${initial.id}`,
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        status: 'lol',
      },
    });

    expect(patchRes.statusCode).toBe(400);

    // 3. Проверяем целостность данных в БД: статус не изменился
    const afterFetch = server.db.getTaskById(initial.id);
    expect(afterFetch).not.toBeNull();
    expect(afterFetch?.status).toBe('todo');
    expect(afterFetch?.updatedAt).toBe(initial.updatedAt);
  });

  /**
   * 6. «PATCH { status: 'review' } → 200»
   * Проверка расширенного набора статусов: статус 'review' из Шага 7a валиден и принимается.
   */
  it('6. PATCH { status: "review" } → 200', async () => {
    const task = server.db.createTask({
      title: 'Задача для код-ревью',
    });

    const res = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}`,
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        status: 'review',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('review');

    const inDb = server.db.getTaskById(task.id);
    expect(inDb?.status).toBe('review');
  });

  /**
   * 7. «PATCH {} → 400»
   * No-op Prevention.
   * Пустое тело обновления считается ошибкой клиента, чтобы не запускать ложные обновления таймстемпов.
   */
  it('7. PATCH {} → 400 (пустое обновление отклоняется)', async () => {
    const task = server.db.createTask({ title: 'Задача' });

    const res = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}`,
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  /**
   * 8. «лишнее поле в теле отбрасывается и в БД не попадает»
   * Mass Assignment / Over-posting Protection.
   * Лишние поля (например, evilField или поддельный id) вычищаются схемой (Zod strip).
   */
  it('8. лишнее поле в теле отбрасывается и в БД не попадает', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'x-client-token': DEFAULT_TOKEN },
      payload: {
        title: 'Задача с лишними полями',
        extraField: 'hacker_payload',
        anotherUnknownKey: 12345,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).extraField).toBeUndefined();
    expect((body.data as Record<string, unknown>).anotherUnknownKey).toBeUndefined();

    // Проверяем прямо в БД: в объекте нет посторонних свойств
    const fromDb = server.db.getTaskById(body.data.id) as unknown as Record<string, unknown>;
    expect(fromDb.extraField).toBeUndefined();
    expect(fromDb.anotherUnknownKey).toBeUndefined();
  });
});
