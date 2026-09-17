import { DELIVERY_RETENTION_MS } from './db/index.js';
import type { Database, DueReminder } from './db/index.js';
import type { Job } from '@organizer/shared';
import type { Scheduler } from './scheduler/index.js';

/**
 * Минутный тик напоминаний — единственное место, где срабатывание переходит из «запланировано»
 * в «выдано» (Шаг 8a.3).
 *
 * ENGLISH PROGRAMMER CONCEPTS:
 * - Tick (тик) — периодический проход джобы, который забирает накопившуюся работу.
 * - Catch-up (догон) — обработка всего, что просрочено, а не только попавшего в текущую минуту.
 * - At-least-once — семантика доставки «хотя бы раз»: лучше повтор, чем тихая потеря.
 *
 * Почему это джоба планировщика, а не собственный `setInterval` в этом модуле:
 * 1. `Scheduler.stopAll()` вызывается на закрытии сервера — таймер, живущий мимо планировщика,
 *    пережил бы приложение и держал процесс (в тестах это утечка на каждый прогон).
 * 2. Джоба видна в `/api/v1/jobs` и переживает рестарт: расписание лежит строкой в таблице `jobs`,
 *    а не в коде процесса.
 * 3. Свой цикл опроса пришлось бы писать, тестировать и останавливать руками — механизм уже есть.
 */
export const REMINDER_TICK_ACTION = 'reminders:dispatch';

/** `* * * * *` — каждая минута: гранулярность напоминаний в модели событий минутная. */
export const REMINDER_TICK_CRON = '* * * * *';

/**
 * `now` — параметр, а не `Date.now()` внутри тела: без подменяемого «сейчас» догон после простоя
 * проверяется только ожиданием реального времени (три часа в тесте), с ним — одним аргументом.
 * Тот же приём делает тест детерминированным: результат не зависит от момента запуска прогона.
 */
export function runReminderTick(db: Database, now: number = Date.now()): DueReminder[] {
  const due = db.claimDueReminders(now);

  // Чистка — той же джобой, что разбирает журнал (decisions.md, Шаг 8a.1): отдельный крон ради
  // одного DELETE — лишний механизм, а без чистки журнал растёт в обход hard cap Шага 7.0.3.
  db.pruneDeliveredOlderThan(now - DELIVERY_RETENTION_MS);

  // Возврат нужен не «на будущее»: это та работа, которую подшаг 8a.4 разошлёт подписчикам SSE.
  // До него сработавшее напоминание помечается выданным и никуда не отправляется — граница шага.
  return due;
}

/**
 * Регистрация тика в планировщике: обработчик под своим именем действия + одна джоба.
 *
 * Почему джоба ищется по `action`, а не добавляется каждый старт: `addJob` генерирует новый `id`
 * на каждый вызов (`randomUUID`), то есть каждый рестарт оставлял бы в таблице `jobs` ещё одну
 * строку с тем же расписанием — тик запускался бы N раз в минуту и N раз рос бы `jobs`.
 * Поиск по действию делает регистрацию идемпотентной и переживает рестарт.
 *
 * Почему обработчик без синхронных внешних команд: блокировка event loop встаёт всем сервером —
 * ни timers, ни poll-очередь не крутятся, HTTP-запросы висят (memory.md, вывод Шага 15.1).
 * Здесь только запросы к локальной SQLite: драйвер `node:sqlite` синхронен по природе, но запрос
 * локальный и короткий. Тяжёлое (уведомления macOS, скрипты плагинов) придёт в 8a.4/8c и только
 * через `await`, а не `execSync`.
 */
export function registerReminderDispatch(db: Database, scheduler: Scheduler): Job {
  scheduler.registerHandler(REMINDER_TICK_ACTION, () => {
    runReminderTick(db);
  });

  const existing = scheduler.listJobs().find((job) => job.action === REMINDER_TICK_ACTION);
  if (existing) return existing;

  return scheduler.addJob({
    name: 'Доставка напоминаний',
    cronExpression: REMINDER_TICK_CRON,
    action: REMINDER_TICK_ACTION,
    target: 'server',
  });
}
