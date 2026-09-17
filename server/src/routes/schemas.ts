import { z } from 'zod';

/**
 * ENGLISH PROGRAMMER CONCEPTS:
 * - DTO (Data Transfer Object) — объект для передачи данных между подсистемами (клиент <-> сервер).
 * - Boundary Validation — валидация на границе системы (API). Любые входящие данные от клиента
 *   считаются недоверенными (Untrusted Input) и должны быть проверены ДО попадания в бизнес-слой и БД.
 * - Sanitization — очистка данных (например, обрезка пробелов `.trim()`).
 * - Over-posting / Mass Assignment — уязвимость, когда злоумышленник передает в JSON лишние поля
 *   (например, id, createdAt, role), пытаясь перетереть системные атрибуты.
 * - Fail-Fast — принцип немедленного прерывания обработки при обнаружении первой ошибки валидации.
 */

// Допустимые статусы задач (Task Statuses) согласно spec.md
export const taskStatuses = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'archived',
] as const;

// Допустимые приоритеты (Task Priorities)
export const taskPriorities = ['low', 'medium', 'high'] as const;

/**
 * Best Practice: Zod Schema для создания задачи (CreateTaskSchema).
 * 
 * 1. Sanitization: `.trim()` удаляет начальные и конечные пробелы.
 * 2. Strict String Check: `.min(1)` гарантирует, что строка пробелов ('   ') не пройдет как валидное название.
 * 3. Type Coercion vs Strict: `z.number().int().positive()` строго отвергает строки вроде "вчера"
 *    и дробные/отрицательные таймстемпы.
 * 4. Stripping (защита от Over-posting): Zod по умолчанию работает в режиме `strip()`,
 *    автоматически удаляя все неизвестные поля, не описанные в схеме.
 */
export const createTaskSchema = z.object({
  title: z
    .string({ required_error: 'Title is required' })
    .trim()
    .min(1, 'Title cannot be empty'),
  description: z.string().optional(),
  status: z.enum(taskStatuses).optional(),
  priority: z.enum(taskPriorities).optional(),
  dueDate: z
    .number({ invalid_type_error: 'dueDate must be a positive integer timestamp' })
    .int('dueDate must be an integer')
    .positive('dueDate must be a positive timestamp')
    .optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Best Practice: Zod Schema для частичного обновления (UpdateTaskSchema).
 * 
 * В REST API:
 * - PUT: полная замена ресурса (все обязательные поля должны присутствовать).
 * - PATCH: частичное изменение ресурса (Partial Update).
 * 
 * Мы берем `createTaskSchema.partial()`, делая каждое поле опциональным.
 * 
 * Подводный камень: если клиент отправит пустой объект `{}` или объект только с неизвестными полями,
 * после strip получится `{}`. Без `.refine()` такой запрос выполнил бы бессмысленную перезапись
 * (No-op = No Operation) с обновлением `updatedAt`.
 * С помощью `.refine()` мы явно требуем передать хотя бы одно валидное поле для обновления.
 */
export const updateTaskSchema = createTaskSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Update payload must contain at least one valid field to update',
  });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/**
 * Best Practice: Boundary Validation для событий — тот же подход, что у задач (`SSoT`).
 * Вынесено сюда, а не в роут, потому что валидация одного ресурса должна иметь один дом:
 * схемы задач уже здесь, а два способа проверки в проекте расходятся молча — расхождение
 * видно только на проде, когда клиент прислал то, что один из маршрутов пропускает.
 *
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Length Bounds (границы длины) — почему именно они, а не «валидатор на всё»: цена невалидного
 *   текста не в самом тексте, а в хранилище. Hard cap Шага 7.0.3 считает число задач, а не их вес,
 *   поэтому одна задача-мегабайт проходит мимо защиты; `.max()` закрывает этот обход на входе.
 * - Integer Timestamp — метка времени UNIX в миллисекундах. Отвергнута мягкая проверка «это число»:
 *   дробное значение проходит её, а в Шаге 8a.3 из `startTime` вычитаются минуты, и `fire_at`
 *   сравнивается с `Date.now()` — дробный `fire_at` никогда не совпадёт с миллисекундным тиком.
 * - Domain Invariant (инвариант предметной области) — «конец события не раньше начала».
 *   Почему на границе API, а не в UI или роуте: правил несколько (веб, cli, планировщик, скрипт),
 *   инвариант один; в UI он недостижим для curl и внешнего скрипта, в роуте — только для одного маршрута.
 * - `.refine()` — Inter-field Validation. Почему не отдельной проверкой в роуте: связь двух полей
 *   нельзя выразить через независимые `z.number()`, а вынесенная наружу проверка потеряется при
 *   переиспользовании схемы (PATCH-схема в Шаге 8b.1 соберётся из этой через `.partial()`).
 * - Fail-Fast: ответ формируется из `issues[0]`. Отвергнут сбор всех ошибок сразу — он нужен формам
 *   в браузере, а здесь клиент программный: ему достаточно первой причины отказа.
 */
export const MAX_EVENT_TITLE_LENGTH = 200;
export const MAX_EVENT_DESCRIPTION_LENGTH = 2_000;
// Верхняя граница интервала напоминания — 7 суток: столько же живёт выданная строка журнала
// (DELIVERY_RETENTION_MS, Шаг 8a.1). Напоминание, отставшее от события сильнее срока хранения журнала,
// смешало бы два разных срока в одном расчёте догона.
export const MAX_REMINDER_MINUTES = 7 * 24 * 60;

export const createEventSchema = z
  .object({
    title: z
      .string({ required_error: 'Title is required' })
      .trim()
      .min(1, 'Title cannot be empty')
      .max(MAX_EVENT_TITLE_LENGTH, `Title cannot exceed ${MAX_EVENT_TITLE_LENGTH} characters`),
    description: z
      .string()
      .max(
        MAX_EVENT_DESCRIPTION_LENGTH,
        `Description cannot exceed ${MAX_EVENT_DESCRIPTION_LENGTH} characters`,
      )
      .optional(),
    startTime: z
      .number({ invalid_type_error: 'startTime must be an integer timestamp' })
      .int('startTime must be an integer')
      .positive('startTime must be a positive timestamp'),
    endTime: z
      .number({ invalid_type_error: 'endTime must be an integer timestamp' })
      .int('endTime must be an integer')
      .positive('endTime must be a positive timestamp'),
    allDay: z.boolean({ invalid_type_error: 'allDay must be a boolean' }).optional(),
    reminderMinutes: z
      .number({ invalid_type_error: 'reminderMinutes must be an integer' })
      .int('reminderMinutes must be an integer')
      .min(0, 'reminderMinutes cannot be negative')
      .max(MAX_REMINDER_MINUTES, `reminderMinutes cannot exceed ${MAX_REMINDER_MINUTES}`)
      .optional(),
  })
  .refine((event) => event.endTime >= event.startTime, {
    message: 'endTime must not be earlier than startTime',
    path: ['endTime'],
  });
