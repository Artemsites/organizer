// Контракты split-архитектуры плагинов Органайзера

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  capabilities?: ('server' | 'client' | 'web')[];
  permissions?: ('bash' | 'browser' | 'cron' | 'filesystem')[];
}

// Контекст сервера для плагина
export interface ServerPluginContext {
  logger: (message: string) => void;
  registerJob: (job: { name: string; cron: string; handler: () => Promise<void> | void }) => void;
  getState: <T = unknown>(key: string) => Promise<T | null> | T | null;
  setState: <T = unknown>(key: string, value: T) => Promise<void> | void;
}

export interface ServerPluginEntry {
  manifest: PluginManifest;
  onReady?(ctx: ServerPluginContext): Promise<void> | void;
  onSync?(clientId: string, payload: unknown): Promise<unknown> | unknown;
  onSchedule?(jobId: string): Promise<void> | void;
}

// Контекст клиента (воркера на Mac) для плагина
export interface ClientPluginContext {
  logger: (message: string) => void;
  exec: (command: string, args?: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  fetchServer: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
}

export interface ClientPluginEntry {
  manifest: PluginManifest;
  onInit?(ctx: ClientPluginContext): Promise<void> | void;
  onCommand?(command: string, args: string[]): Promise<void> | void;
  onBrowserTask?(taskName: string, params: Record<string, unknown>): Promise<unknown> | unknown;
}

// Контекст Web UI для плагина
export interface WebPluginEntry {
  manifest: PluginManifest;
  mount(container: HTMLElement): void;
  unmount?(): void;
}
