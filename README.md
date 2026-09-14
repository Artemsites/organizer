# Органайзер

Пет-проект для обучения лучшим практикам frontend, backend и CLI-разработки.
Единое ядро на Node.js и два интерфейса к нему — браузерный и консольный.

Требования и архитектура — [spec.md](./spec.md). План работ — [plan.md](./plan.md).

## Запуск

Нужен Node.js 22.5+ (проверено на 24), пакетный менеджер `npm` с workspaces.

```bash
npm install                 # из корня, ставит все воркспейсы
cp .env.example .env
openssl rand -hex 32        # сгенерировать ORGANIZER_TOKEN и вписать в .env

npm run server:dev          # ядро на http://127.0.0.1:3000
npm run web:dev             # Web UI на http://localhost:5173
```

Web ходит в ядро через прокси Vite (`/api`), поэтому нужны обе команды.

## Конфигурация

Один `.env` в корне монорепо, в `.gitignore`. Образец — `.env.example`.

| Переменная | Назначение |
|---|---|
| `ORGANIZER_TOKEN` | Секрет для заголовка `X-Client-Token`. Без него ядро отвечает 401 |
| `ORGANIZER_URL` | Адрес ядра для прокси Vite. По умолчанию `http://127.0.0.1:3000` |

Сервер читает `.env` нативным флагом Node `--env-file-if-exists` (см. `dev`-скрипт в `server/package.json`), Vite — через `loadEnv` с пустым префиксом. Пакет `dotenv` не используется.

**Токен никогда не читать через `import.meta.env` / `VITE_*`** — Vite встраивает такие переменные в клиентский бандл, и секрет становится виден любому посетителю страницы.

## Тесты

```bash
npm --prefix server run test
npm --prefix cli run test
npm --prefix web run test
```

## Частые ошибки

- **`curl` к локальному порту отдаёт 502.** В окружении задан глобальный `HTTP_PROXY=127.0.0.1:1080`, и `curl` идёт через него. Запускать с `NO_PROXY='*'`.
- **`curl http://127.0.0.1:5173` молчит, а `localhost:5173` работает.** Vite dev слушает только IPv6 `[::1]`.
- **Ядро стартует, но все запросы дают 401.** Не задан `ORGANIZER_TOKEN` в `.env`, либо `.env` не в корне монорепо.

## Структура

```text
server/    ядро: Fastify REST API, node:sqlite (WAL), croner
cli/       терминал и локальный воркер на macOS (cac, zx, playwright)
web/       браузерный интерфейс (Vite, Vanilla TS, SCSS)
shared/    общие типы, DTO и контракты плагинов
plugins/   плагины (split: server + cli + web)
```

## Деплой

Beget (Passenger, cron fallback) — Шаг 12 в `plan.md`, ещё не сделан. Перед ним Шаг 16: прогон тестов и линтеров плюс `rsync` по SSH. Деплой не выполняется при красном прогоне.
