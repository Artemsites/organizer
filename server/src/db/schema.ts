// Схема базы данных SQLite для ядра Органайзера

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Таблица задач (Tasks)
-- BEST PRACTICE: Database-level Integrity Constraints (Ограничения целостности на уровне СУБД).
-- Даже если валидация на уровне API будет обойдена (например, баг в коде, прямой скрипт или миграция),
-- СУБД SQLite физически не позволит сохранить недопустимые значения (Defense-in-Depth / Эшелонированная защита).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'done', 'archived')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_date INTEGER,
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Таблица событий календаря (Events)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  all_day INTEGER DEFAULT 0,
  reminder_minutes INTEGER,
  created_at INTEGER NOT NULL
);

-- Журнал доставки напоминаний (Delivery Log) — служебная таблица, не часть модели.
-- BEST PRACTICE: Database-level Deduplication (дедуп на уровне СУБД, а не флаг в памяти).
-- UNIQUE (event_id, fire_at) переживает рестарт процесса, флаг «отправлено» в памяти — нет:
-- повторное планирование того же срабатывания отклоняет сам SQLite (Defense-in-Depth).
-- ON DELETE CASCADE: удаление события уносит его строки журнала без второго вызова из роута,
-- сирот (orphaned rows) не остаётся. FOREIGN KEY работает, потому что выше включён foreign_keys = ON.
-- CHECK на статус — тот же приём, что CHECK на tasks: недопустимое состояние не запишется
-- даже при баге в прикладном коде. Семантика at-least-once и retention 7 суток — decisions.md (Шаг 8a.1):
-- выданные строки старше срока чистит та же джоба, что разбирает журнал, иначе таблица растёт
-- в обход hard cap Шага 7.0.3 (тот же класс отказа — заполнение диска).
CREATE TABLE IF NOT EXISTS delivery_log (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  fire_at INTEGER NOT NULL,
  delivered_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_log_event_fire ON delivery_log(event_id, fire_at);

-- Состояние плагинов (Key-Value per plugin)
CREATE TABLE IF NOT EXISTS plugins_state (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

-- Задачи планировщика (Cron jobs)
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'server',
  action TEXT NOT NULL,
  params TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run INTEGER,
  next_run INTEGER
);

-- Зарегистрированные клиенты (Mac/Linux воркеры)
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'online'
);
`;
