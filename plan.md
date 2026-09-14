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
# Органайзер - Спецификация системы:
**Пет-проект для обучения лучшим практикам frontend & backend & cli разработки.**

## Главные принципы, по приоритетам:
0. **Security приложения**: 
данные пользователя и его пк должны быть под 100% защитой! Ни доли процента не должно быть вреда данных пользователя (потери/повреждения/кражи) или вреда для пк пользователя! 
1. **Быстрота выполнения производительности** сервиса во всех частях и в целом!
2. **Простота и минимализм** - проект должен быть максимально простой и минималистичный.
   2.1. Если можно **эффективно и минимально сделать из нативных инструментов**, то делаем нативными!
   2.2. Если **эффективнее и минимальнее будет сделать какую-то часть с помощью opensource библиотеки** или framework то делаем!

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

- [ ] Шаг 7 (Приоритет 0): `todos` — Список задач (Web UI + Server API) `[Model: Mid, Effort: Medium]`
  - Расширение статусов `TaskStatus`: `'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'archived'`.
  - Подключение `web/src/modules/todos/` к REST API сервера (`/api/v1/tasks`) вместо localStorage.
  - Оптимистичный UI, фильтрация по статусам (`todo`, `in_progress`, `review`, `done`), приоритеты (low / medium / high).
  - Практика: нативный DOM API, делегирование событий, SCSS-стили, анимация смены статуса.
  - TDD: интеграционные проверки связки.

- [ ] Шаг 8 (Приоритет 1): `reminders` — Напоминальщик событий (Ядро + Web + CLI) `[Model: Mid, Effort: High]`
  - Название: **`reminders`** (Напоминания / Напоминальщик).
  - Сервер: маршруты `/api/v1/events` и `/api/v1/reminders`, фоновый таймер/крон на `croner`.
  - Web: модуль `RemindersModule` с отображением дедлайнов, таймерами обратного отсчета и Web Notifications API.
  - CLI воркер: системные уведомления macOS (`osascript` notification).
  - TDD: unit тесты триггеров напоминаний.

- [ ] Шаг 9 (Приоритет 2): `backlog` — Бэклог задач, не назначенных на напоминальщик `[Model: Mid, Effort: Medium]`
  - Представление задач с фильтром по статусу `status = 'backlog'`.
  - Быстрый перевод из бэклога в работу (смена статуса на `todo` с датой) или в напоминание.
  - Web: модуль `BacklogModule` (фильтрация по тегам, поиск, группировка).
  - TDD: unit тесты API и фильтрации бэклога.

- [ ] Шаг 10 (Приоритет 3): `kanban` — Задачник в виде столбцов (Trello-доска задач со столбцом Backlog) `[Model: Mid, Effort: High]`
  - 5 столбцов доски: `Backlog`, `To Do`, `In Progress`, `Review`, `Done`.
  - Вёрстка: адаптивный CSS Grid + Flexbox, адаптив под разные экраны.
  - Практика: нативный **HTML5 Drag and Drop API** (`dragstart`, `dragover`, `drop`, визуальный placeholder) без внешних библиотек.
  - Перетаскивание карточки меняет статус задачи через `PATCH /api/v1/tasks/:id { status }`.

- [ ] Шаг 11 (Приоритет 4): `calendar` — Графическое отображение напоминальщика событий в календаре `[Model: Mid, Effort: High]`
  - Сетка месяца и недели на **CSS Grid** (`repeat(7, 1fr)`).
  - Адаптив под 4-5 брейкпоинтов (десктоп, планшет, мобильный).
  - Отображение событий из `reminders` и задач с `dueDate` из `todos`.
  - Микро-анимации смены месяца через CSS `transform` и `opacity`.

- [ ] Шаг 12: Production сборка и деплой на Beget (Passenger, cron fallback) `[Model: Pro, Effort: High]`
  - Конфигурация Passenger для долгоживущего Node.js процесса.
  - Fallback cron через HTTP healthcheck.
  - E2E проверка полного цикла: Web -> Server -> CLI worker.
