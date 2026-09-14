# PROJECT.md: Архитектура Органайзера

## 1. Архитектура: Единое Ядро и два интерфейса
Система состоит из единого центрального Ядра (Server) и двух независимых интерфейсов-клиентов (CLI-воркер и Web UI):

```text
                  ┌──────────────────────────────────────────────┐
                  │          ЯДРО (server/)                      │
                  │   Backend-оркестратор + Fastify REST API     │
                  │   SQLite (node:sqlite WAL) + croner          │
                  │   Серверная логика и каталог плагинов        │
                  └──────────────▲────────────────▲──────────────┘
                                 │                │
                     REST API    │                │  REST API
                  (X-Client-Token)│               │
                                 ▼                ▼
         ┌───────────────────────────────┐   ┌───────────────────────────┐
         │             cli/              │   │            web/           │
         │   Консольный интерфейс +      │   │    Графический интерфейс  │
         │   Локальный воркер (Mac/Linux)│   │       (Браузер)           │
         │   - Команды в терминале (cac) │   │   - Визуальный UI         │
         │   - Запуск bash / zx / node   │   │   - Календарь, карточки   │
         │   - Puppeteer (веб-робот)     │   │   - Vanilla TS + SCSS     │
         └───────────────────────────────┘   └───────────────────────────┘
```

## 2. Структура монорепозитория
- `server/` — ядро системы (Fastify REST API, SQLite, планировщик croner, auth `x-client-token`).
- `cli/` — CLI-клиент и локальный воркер на macOS/Linux (cac, zx, puppeteer-core).
- `web/` — нативный графический веб-интерфейс (Vanilla TypeScript, SCSS `@use`, DOM API, Vite).
- `plugins/` — модули и плагины со split-архитектурой.
- `shared/` — системные контракты, DTO и интерфейсы ядра (`@organizer/shared`).

## 3. База данных и хранилище (SQLite)
- Реализовано на встроенном модуле Node.js 22.5+ `node:sqlite` (`DatabaseSync`).
- Режим: `PRAGMA journal_mode = WAL;`, `PRAGMA foreign_keys = ON;`.
- Таблицы:
  - `tasks`: задачи, дедлайны, приоритеты, теги (JSON), статусы (`todo`, `in_progress`, `done`, `archived`).
  - `events`: события календаря, таймстемпы начала и конца, напоминания.
  - `reminders`: разовые и интервальные напоминания.
  - `plugins_state`: Key-Value хранилище состояния плагинов (`plugin_id`, `key`, `value`).
  - `jobs`: задачи планировщика (`id`, `name`, `cron_expression`, `target`, `action`, `params`, `enabled`, `last_run`, `next_run`).
  - `clients`: зарегистрированные клиенты (`id`, `name`, `platform`, `last_seen`, `status`).
  - Дневник: локальные markdown-файлы.

## 4. Спецификация split-плагинов
Каждый плагин изолирован и содержит до 4 частей:
- `manifest.yml` — метаданные, id, permissions (`bash`, `browser`, `cron`), capabilities (`server`, `client`, `web`).
- `server/entry.ts` — серверная логика: хуки `onReady(ctx)`, `onSync(clientId, payload)`, `onSchedule(jobId)`.
- `client/entry.ts` — локальная автоматизация на Mac: хуки `onInit(ctx)`, `onCommand(cmd, args)`, `onBrowserTask(task, params)`.
- `web/entry.ts` — монтирование визуального компонента в DOM Web UI: `mount(container)`, `unmount()`.
