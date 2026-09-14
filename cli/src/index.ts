import { cac } from 'cac';
import os from 'node:os';
import { ApiClient } from './api-client.js';
import { PluginLoader } from './plugin-loader.js';

export function createCli(apiClient: ApiClient = new ApiClient()) {
  const cli = cac('organizer');
  const loader = new PluginLoader(apiClient);

  // organizer status
  cli
    .command('status', 'Проверить статус ядра сервера и локального воркера')
    .action(async () => {
      console.log('--- Organizer CLI Status ---');
      console.log(`Platform: ${os.platform()} (${os.arch()})`);
      console.log(`Hostname: ${os.hostname()}`);
      try {
        const health = await apiClient.health();
        console.log(`Server: Online (status: ${health.status}, time: ${new Date(health.timestamp).toLocaleTimeString()})`);
      } catch (err: unknown) {
        console.log(`Server: Offline or unreachable (${(err as Error).message})`);
      }
    });

  // organizer task list
  cli
    .command('task:list', 'Список задач')
    .option('--status <status>', 'Фильтр по статусу (todo, in_progress, done)')
    .action(async (options) => {
      try {
        const tasks = await apiClient.getTasks(options.status);
        if (tasks.length === 0) {
          console.log('Список задач пуст.');
          return;
        }
        console.log(`\nЗадачи (${tasks.length}):`);
        for (const t of tasks) {
          const statusIcon = t.status === 'done' ? '✓' : '○';
          console.log(`  [${statusIcon}] ${t.title} (приоритет: ${t.priority}, id: ${t.id})`);
        }
      } catch (err: unknown) {
        console.error('Ошибка получения задач:', (err as Error).message);
      }
    });

  // organizer task add <title>
  cli
    .command('task:add <title>', 'Добавить новую задачу')
    .option('--priority <priority>', 'Приоритет: low, medium, high', { default: 'medium' })
    .action(async (title, options) => {
      try {
        const created = await apiClient.createTask({
          title,
          priority: options.priority,
        });
        console.log(`✓ Задача создана: "${created.title}" [id: ${created.id}]`);
      } catch (err: unknown) {
        console.error('Ошибка создания задачи:', (err as Error).message);
      }
    });

  // organizer task done <id>
  cli
    .command('task:done <id>', 'Отметить задачу выполненной')
    .action(async (id) => {
      try {
        const updated = await apiClient.updateTask(id, { status: 'done' });
        console.log(`✓ Задача "${updated.title}" отмечена выполненной!`);
      } catch (err: unknown) {
        console.error('Ошибка обновления задачи:', (err as Error).message);
      }
    });

  // organizer sync
  cli
    .command('sync', 'Выполнить синхронизацию с сервером')
    .action(async () => {
      try {
        const clientId = `mac-${os.hostname()}`;
        console.log(`Синхронизация узла ${clientId} с сервером...`);
        const result = await apiClient.sync({
          clientId,
          lastSyncAt: 0,
        });
        console.log(`✓ Синхронизация успешна! Получено задач: ${result.tasks.length}, событий: ${result.events.length}`);
      } catch (err: unknown) {
        console.error('Ошибка синхронизации:', (err as Error).message);
      }
    });

  // organizer plugin list
  cli
    .command('plugin:list', 'Список доступных плагинов на сервере')
    .action(async () => {
      try {
        const plugins = await apiClient.getPlugins();
        if (plugins.length === 0) {
          console.log('На сервере нет зарегистрированных плагинов.');
          return;
        }
        console.log(`\nПлагины (${plugins.length}):`);
        for (const p of plugins) {
          console.log(`  * ${p.name} (id: ${p.id}, v${p.version})`);
          if (p.description) console.log(`    ${p.description}`);
        }
      } catch (err: unknown) {
        console.error('Ошибка получения плагинов:', (err as Error).message);
      }
    });

  cli.help();
  cli.version('0.1.0');

  return { cli, loader };
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const { cli } = createCli();
  cli.parse();
}
