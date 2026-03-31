// Dirigent Client SDK

import { io, Socket } from 'socket.io-client';

export interface DirigentClientOptions {
  url: string;
  token?: string;
  autoReconnect?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  template: string;
  status: string;
  workspace?: string;
  model?: string;
  pid?: number;
  currentTask?: string;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  error?: string;
}

export interface SpawnOptions {
  template: string;
  name?: string;
  workspace?: string;
  task?: string;
  model?: string;
}

export class DirigentClient {
  private url: string;
  private token?: string;
  private socket: Socket | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();

  constructor(options: DirigentClientOptions) {
    this.url = options.url;
    this.token = options.token;
  }

  // REST API methods

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(`${this.url}/api${path}`, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string };
      throw new Error(error.error || error.message || 'Request failed');
    }

    return res.json() as Promise<T>;
  }

  async status() {
    return this.fetch<{
      status: string;
      uptime: number;
      agents: {
        total: number;
        running: number;
        idle: number;
        stopped: number;
        error: number;
        list: Agent[];
      };
    }>('/status');
  }

  async listAgents(includeStopped = false) {
    const result = await this.fetch<{ agents: Agent[] }>(
      `/agents${includeStopped ? '?all=true' : ''}`
    );
    return result.agents;
  }

  async getAgent(id: string) {
    const result = await this.fetch<{ agent: Agent }>(`/agents/${id}`);
    return result.agent;
  }

  async spawnAgent(options: SpawnOptions) {
    const result = await this.fetch<{ agent: Agent }>('/agents', {
      method: 'POST',
      body: JSON.stringify(options),
    });
    return result.agent;
  }

  async stopAgent(id: string, force = false) {
    await this.fetch(`/agents/${id}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    });
  }

  async sendToAgent(id: string, message: string) {
    await this.fetch(`/agents/${id}/send`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async getAgentLogs(id: string, lines = 100) {
    const result = await this.fetch<{ logs: any[] }>(`/agents/${id}/logs?lines=${lines}`);
    return result.logs;
  }

  async getTemplates() {
    const result = await this.fetch<{ templates: any[] }>('/templates');
    return result.templates;
  }

  // WebSocket methods

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, {
        auth: this.token ? { token: this.token } : undefined,
        reconnection: true,
      });

      this.socket.on('connect', () => {
        if (this.token) {
          this.socket!.emit('auth', { token: this.token });
        }
        resolve();
      });

      this.socket.on('auth', (data) => {
        if (!data.success) {
          reject(new Error(data.error || 'Authentication failed'));
        }
      });

      this.socket.on('disconnect', () => {
        this.emit('disconnect', {});
      });

      this.socket.on('agent:created', (data) => this.emit('agent:created', data));
      this.socket.on('agent:running', (data) => this.emit('agent:running', data));
      this.socket.on('agent:stopped', (data) => this.emit('agent:stopped', data));
      this.socket.on('agent:error', (data) => this.emit('agent:error', data));
      this.socket.on('agent:log', (data) => this.emit('agent:log', data));

      this.socket.on('connect_error', reject);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  subscribeToAgents() {
    if (!this.socket) throw new Error('Not connected');
    this.socket.emit('subscribe:agents');
  }

  subscribeToLogs(agentId: string) {
    if (!this.socket) throw new Error('Not connected');
    this.socket.emit('subscribe:logs', { agentId });
  }

  unsubscribeFromLogs(agentId: string) {
    if (!this.socket) throw new Error('Not connected');
    this.socket.emit('unsubscribe:logs', { agentId });
  }

  on(event: string, callback: (data: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  private emit(event: string, data: any) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        callback(data);
      }
    }
  }
}

// Factory function
export function createClient(options: DirigentClientOptions): DirigentClient {
  return new DirigentClient(options);
}

export default DirigentClient;
