import type {
  Task,
  CalendarEvent,
  CreateTaskDto,
  UpdateTaskDto,
  SyncPayload,
  SyncResult,
  PluginManifest,
  ApiResponse,
} from '@organizer/shared';

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
}

export class ApiClient {
  private baseUrl: string;
  private token: string;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.ORGANIZER_SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
    this.token = options.token || process.env.ORGANIZER_TOKEN || 'organizer-secret-token';
  }

  async health(): Promise<{ status: string; timestamp: number }> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<{ status: string; timestamp: number }>;
  }

  async getTasks(status?: string): Promise<Task[]> {
    const url = new URL(`${this.baseUrl}/api/v1/tasks`);
    if (status) {
      url.searchParams.set('status', status);
    }
    const res = await this.request<Task[]>(url.toString());
    return res.data || [];
  }

  async createTask(dto: CreateTaskDto): Promise<Task> {
    const res = await this.request<Task>(`${this.baseUrl}/api/v1/tasks`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    if (!res.data) {
      throw new Error(res.error || 'Failed to create task');
    }
    return res.data;
  }

  async updateTask(id: string, dto: UpdateTaskDto): Promise<Task> {
    const res = await this.request<Task>(`${this.baseUrl}/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
    if (!res.data) {
      throw new Error(res.error || 'Failed to update task');
    }
    return res.data;
  }

  async deleteTask(id: string): Promise<boolean> {
    const res = await this.request<void>(`${this.baseUrl}/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.success;
  }

  async sync(payload: SyncPayload): Promise<SyncResult> {
    const res = await this.request<SyncResult>(`${this.baseUrl}/api/v1/sync`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.data) {
      throw new Error(res.error || 'Sync failed');
    }
    return res.data;
  }

  async getPlugins(): Promise<PluginManifest[]> {
    const res = await this.request<PluginManifest[]>(`${this.baseUrl}/api/v1/plugins`);
    return res.data || [];
  }

  async fetchPluginClientCode(pluginId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/v1/plugins/${encodeURIComponent(pluginId)}/client`, {
      headers: {
        'x-client-token': this.token,
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch plugin client code: ${res.status}`);
    }
    return res.text();
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
    const headers = new Headers(init.headers || {});
    headers.set('x-client-token', this.token);
    if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      ...init,
      headers,
    });

    const body = (await response.json()) as ApiResponse<T>;
    if (!response.ok && !body.error) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return body;
  }
}
