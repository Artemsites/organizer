import { $ } from 'zx';
import type { ClientPluginContext, ClientPluginEntry, PluginManifest } from '@organizer/shared';
import type { ApiClient } from './api-client.js';

export class PluginLoader {
  private apiClient: ApiClient;
  private loadedPlugins: Map<string, ClientPluginEntry> = new Map();

  constructor(apiClient: ApiClient) {
    this.apiClient = apiClient;
  }

  createContext(): ClientPluginContext {
    return {
      logger: (msg: string) => console.log(`[Plugin] ${msg}`),
      exec: async (command: string, args: string[] = []) => {
        try {
          const result = await $`${command} ${args}`;
          return {
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            exitCode: result.exitCode ?? 0,
          };
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; exitCode?: number };
          return {
            stdout: e.stdout?.trim() || '',
            stderr: e.stderr?.trim() || String(err),
            exitCode: e.exitCode ?? 1,
          };
        }
      },
      fetchServer: async <T>(path: string, options?: RequestInit) => {
        const res = await this.apiClient.request<T>(`${(this.apiClient as unknown as { baseUrl: string }).baseUrl}${path}`, options);
        return res.data as T;
      },
    };
  }

  // Загрузка плагина из строки исходного кода (ESM модуль)
  async loadFromCode(manifest: PluginManifest, code: string): Promise<ClientPluginEntry> {
    const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    const module = await import(dataUri);
    const entry: ClientPluginEntry = module.default || module;

    entry.manifest = manifest;
    const ctx = this.createContext();

    if (entry.onInit) {
      await entry.onInit(ctx);
    }

    this.loadedPlugins.set(manifest.id, entry);
    return entry;
  }

  // Загрузка и инициализация плагина с сервера по ID
  async pullAndLoad(pluginId: string): Promise<ClientPluginEntry> {
    const plugins = await this.apiClient.getPlugins();
    const manifest = plugins.find((p) => p.id === pluginId);
    if (!manifest) {
      throw new Error(`Plugin ${pluginId} not found on server`);
    }

    const code = await this.apiClient.fetchPluginClientCode(pluginId);
    return this.loadFromCode(manifest, code);
  }

  getLoadedPlugins(): ClientPluginEntry[] {
    return [...this.loadedPlugins.values()];
  }

  async executeCommand(pluginId: string, command: string, args: string[] = []): Promise<void> {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} is not loaded`);
    }
    if (plugin.onCommand) {
      await plugin.onCommand(command, args);
    }
  }
}
