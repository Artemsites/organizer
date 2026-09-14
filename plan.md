# План: Органайзер (Ядро и два интерфейса CLI & Web)

## Архитектура монорепозитория
```text
organizer/
├── server/       # Ядро: Fastify REST API, node:sqlite (WAL), croner
├── cli/          # Интерфейс терминала + локальный воркер на macOS (cac, zx, puppeteer)
├── web/          # Графический интерфейс в браузере (Vite, Vanilla TS, SCSS)
├── plugins/      # Плагины (split: server + cli + web)
├── shared/       # Общие типы, DTO и контракты плагинов
├── spec.md       # Спецификация
├── plan.md       # План разработки
└── memory.md     # Архитектурная память
```

## Шаги реализации

- [x] Шаг 0: Базовый каркас Web UI в `web/` (Vite + Vanilla TS + SCSS + AppShell) `[Model: Mid, Effort: Medium]`
  - Layout: sidebar + main view, темы, SCSS токены.
  - Базовые модули на нативном DOM API (Todo, Notes).

- [x] Шаг 1: Инициализация структуры монорепо (`server`, `cli`, `shared`) на npm `[Model: Pro, Effort: Medium]`
  - Настройка `npm workspaces` в `organizer/package.json`.
  - Каркасы пакетов `@organizer/shared`, `@organizer/server`, `@organizer/cli`, `@organizer/web`.
  - Корневые скрипты сборки и запуска, проверка билда.

- [x] Шаг 2: Системные контракты и типы ядра в `shared/` (интерфейсы плагинов, DTO) `[Model: Pro, Effort: Medium]`
  - Контракты плагина: `manifest.yml`, `server/entry.ts`, `client/entry.ts`, `web/entry.ts`.
  - Хуки сервера: `onReady`, `onSync`, `onSchedule`.
  - Хуки клиента: `onInit`, `onCommand`, `onBrowserTask`.
  - Общие DTO для событий, задач, таймеров, авторизации.

- [x] Шаг 3: Ядро сервера (`server/`): Fastify + REST API + Auth (`X-Client-Token`) + `node:sqlite` с WAL `[Model: Pro, Effort: High]`
  - Слой БД `node:sqlite` с режимом WAL и миграциями.
  - Таблицы: `events`, `tasks`, `reminders`, `plugins_state`, `jobs`, `clients`.
  - Дневник — markdown-файлы.
  - TDD: unit CRUD тесты.

- [x] Шаг 4: Планировщик фоновых задач сервера (`server/`): интеграция `croner` `[Model: Mid, Effort: Medium]`
  - croner: задачи, таймеры, триггеры для клиентов.
  - TDD: unit тесты планировщика.

- [x] Шаг 5: REST API + Auth + Sync на сервере (`server/`) `[Model: Pro, Effort: High]`
  - Маршруты `/api/v1/*` (проверка `X-Client-Token`).
  - Синхронизация состояния и раздача `client`-частей плагинов.
  - TDD: integration тесты (fastify.inject).

- [x] Шаг 6: CLI-клиент и загрузчик (`cli/`): `cac`, `zx`, `puppeteer` `[Model: Pro, Effort: High]`
  - Авторизация, pull клиентских частей плагинов.
  - Динамический import `client/entry.ts` из скачанных плагинов.
  - API для плагинов: вызов bash (через `zx`), управление puppeteer.
  - TDD: unit (загрузчик, runner).

- [ ] Шаг 7: Базовые плагины MVP (`calendar`, `timer`, `backlog`, `updater`, `browser-automation`, `moon-phase`) `[Model: Mid, Effort: High]`
  - `calendar`: server-api -> client-view.
  - `timer`: server-schedule -> client-notify / client-script.
  - `backlog`: server-db -> link to `calendar`.
  - `browser-automation`: server-trigger -> client-puppeteer.
  - `moon-phase`: server-cron (suncalc) -> client-notify.
  - `updater`: client-cron -> client-bash (brew/npm/etc).
  - TDD: unit тесты каждого плагина.

- [ ] Шаг 8: Подключение Web UI (`web/`) к REST API Ядра (`server/`) `[Model: Mid, Effort: Medium]`
  - API-клиент в `web/` для запросов к Fastify.
  - Связка визуальных списков задач, календаря и бэклога с БД сервера.

- [ ] Шаг 9: Подготовка деплоя на Beget (Passenger, cron fallback, production build) `[Model: Pro, Effort: High]`
  - Проверка Passenger для долгоживущего процесса.
  - Beget cron fallback (`curl /health`).
  - E2E: Client sync -> trigger server cron -> client execution.
