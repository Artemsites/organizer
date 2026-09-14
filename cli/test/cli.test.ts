import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, registerServerPlugin } from '@organizer/server';
import { ApiClient } from '../src/api-client.js';
import { PluginLoader } from '../src/plugin-loader.js';
import { createCli } from '../src/index.js';

describe('Organizer CLI: ApiClient & Server Integration', () => {
  let serverInstance: Awaited<ReturnType<typeof createServer>>;
  let port: number;
  let client: ApiClient;

  beforeAll(async () => {
    serverInstance = await createServer({ dbLocation: ':memory:', startScheduler: false });
    const address = await serverInstance.app.listen({ port: 0, host: '127.0.0.1' });
    port = Number(new URL(address).port);
    client = new ApiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'organizer-secret-token',
    });
  });

  afterAll(async () => {
    await serverInstance.app.close();
  });

  it('health() возвращает статус сервера', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.timestamp).toBeDefined();
  });

  it('createTask() и getTasks() работают корректно', async () => {
    const created = await client.createTask({
      title: 'Купить молоко через CLI',
      priority: 'high',
    });

    expect(created.id).toBeDefined();
    expect(created.title).toBe('Купить молоко через CLI');

    const list = await client.getTasks();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);
  });

  it('sync() передает и принимает данные с сервера', async () => {
    const result = await client.sync({
      clientId: 'test-mac-cli',
      lastSyncAt: 0,
    });

    expect(result.tasks.length).toBe(1);
    expect(result.serverTimestamp).toBeDefined();
  });
});

describe('Organizer CLI: PluginLoader & Local Worker', () => {
  it('loadFromCode инициализирует плагин и вызывает onInit', async () => {
    const client = new ApiClient();
    const loader = new PluginLoader(client);

    let initialized = false;
    let commandArg = '';

    const testPluginCode = `
      export default {
        async onInit(ctx) {
          ctx.logger('Plugin initialized');
        },
        async onCommand(cmd, args) {
          if (cmd === 'test') {
            globalThis.__test_arg = args[0];
          }
        }
      };
    `;

    const entry = await loader.loadFromCode(
      {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
      },
      testPluginCode
    );

    expect(entry).toBeDefined();
    expect(loader.getLoadedPlugins().length).toBe(1);

    await loader.executeCommand('test-plugin', 'test', ['hello-world']);
    expect((globalThis as unknown as { __test_arg: string }).__test_arg).toBe('hello-world');
  });

  it('createCli регистрирует все команды', () => {
    const { cli } = createCli();
    const commandNames = cli.commands.map((c) => c.name);

    expect(commandNames).toContain('status');
    expect(commandNames).toContain('task:list');
    expect(commandNames).toContain('task:add');
    expect(commandNames).toContain('task:done');
    expect(commandNames).toContain('sync');
    expect(commandNames).toContain('plugin:list');
  });
});
