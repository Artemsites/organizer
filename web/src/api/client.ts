/**
 * Thin HTTP-обёртка (thin wrapper) к ядру: никаких своих DTO, только `@organizer/shared`.
 * SSoT (Single Source of Truth) — один тип `Task` на CLI, server и web.
 *
 * Почему не класс как в CLI: в браузере нет токена и нет baseUrl —
 * same-origin `/api/v1`, токен ставит Vite-прокси (Шаг 7.0). Состояние нечем хранить.
 */
import type {
  ApiResponse,
  CreateTaskDto,
  Task,
  TaskStatus,
  UpdateTaskDto,
} from '@organizer/shared';

const API_V1 = '/api/v1';

/**
 * Generic `request<T>` — один раз разобрать JSON, методы только называют ресурс.
 *
 * Fail the fetch: не-2xx → `throw`. Шаг 7b (optimistic UI) в `catch` откатит DOM.
 *
 * Event loop (Chrome): `fetch` — macrotask (task queue), `.json()` — ещё одна.
 * DOM в 7b менять ДО `await request(...)`, иначе кадр рисуется уже после ответа.
 *
 * `init?.body` / `body.error` — optional chaining: нет свойства → undefined, без throw.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T | undefined> {
  const res = await fetch(`${API_V1}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await res.json()) as ApiResponse<T>;
  if (!res.ok) {
    throw new Error(body.error);
  }
  return body.data;
}

/**
 * Query string для фильтра. Массив → `?status=todo,in_progress` (один round-trip).
 * `encodeURIComponent` — пробелы и запятые не сломают URL.
 */
function statusQuery(status?: TaskStatus | readonly TaskStatus[]): string {
  if (status === undefined) return '';
  const list = Array.isArray(status) ? status : [status];
  if (list.length === 0) return '';
  return `?status=${encodeURIComponent(list.join(','))}`;
}

export async function listTasks(status?: TaskStatus | readonly TaskStatus[]): Promise<Task[]> {
  return (await request<Task[]>(`/tasks${statusQuery(status)}`)) ?? [];
}

export async function createTask(dto: CreateTaskDto): Promise<Task> {
  const task = await request<Task>('/tasks', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
  if (!task) throw new Error('Empty create response');
  return task;
}

export async function patchTask(id: string, dto: UpdateTaskDto): Promise<Task> {
  const task = await request<Task>(`/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(dto),
  });
  if (!task) throw new Error('Empty patch response');
  return task;
}

export async function deleteTask(id: string): Promise<void> {
  await request<void>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
