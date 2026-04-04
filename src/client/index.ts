/**
 * Dirigent Agent Client SDK
 *
 * Allows any Node.js agent to self-register with a Dirigent server,
 * receive a signed tool manifest, and respond to real-time control commands.
 *
 * Usage:
 *   import { DirigentClient } from 'diragent/client';
 *
 *   const client = new DirigentClient({
 *     serverUrl: 'ws://localhost:3000',
 *     agent: { id: 'my-bot', name: 'My Bot', type: 'clawdbot', version: '1.0.0' },
 *   });
 *
 *   await client.connect();
 *
 *   if (client.canUseTool('exec', 'full')) { ... }
 *
 *   client.on('kill',  () => process.exit(0));
 *   client.on('pause', () => { suspended = true; });
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

// ── Public types ──────────────────────────────────────────────────────────────

export interface AgentInfo {
  /** Stable unique identifier for this agent instance */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Agent runtime type, e.g. 'clawdbot', 'langchain', 'custom' */
  type: string;
  version?: string;
  capabilities?: string[];
}

export interface DirigentClientOptions {
  /** Dirigent server URL — accepts ws://, wss://, http://, or https:// */
  serverUrl: string;
  agent: AgentInfo;
  /** Re-connect automatically on disconnect (default: true) */
  reconnect?: boolean;
  /** Initial reconnect delay in ms (default: 3000, grows exponentially) */
  reconnectDelay?: number;
  /** Max reconnect delay in ms (default: 30000) */
  reconnectMaxDelay?: number;
  /** Heartbeat ping interval in ms (default: 30000) */
  heartbeatInterval?: number;
}

export type AccessLevel = 'none' | 'read' | 'full';

export interface ManifestTool {
  access: AccessLevel;
  scope: object;
}

export interface Manifest {
  version: number;
  agentId: string;
  issuedAt: string;
  expiresAt: string;
  tools: Record<string, ManifestTool>;
  signature: string | null;
}

export type AgentCommand = 'kill' | 'pause' | 'resume';

// ── Event map (for typed .on() overloads) ────────────────────────────────────

export interface DirigentClientEvents {
  /** WebSocket connection established */
  connect: [];
  /** Disconnected from server (reconnect may follow) */
  disconnect: [];
  /** Registration confirmed — first manifest delivered */
  registered: [{ agentId: string; manifest: Manifest }];
  /** Manifest received or updated (also fires on registration) */
  manifest: [Manifest];
  /** Any control command received */
  command: [{ command: AgentCommand }];
  /** Kill command — agent should shut down */
  kill: [];
  /** Pause command — agent should stop accepting new work */
  pause: [];
  /** Resume command — agent may resume work */
  resume: [];
  /** About to attempt reconnect */
  reconnecting: [{ attempt: number; delay: number }];
  /** Connection or protocol error */
  error: [Error];
}

// ── Client ────────────────────────────────────────────────────────────────────

export class DirigentClient extends EventEmitter {
  private readonly opts: Required<DirigentClientOptions>;
  private ws: WebSocket | null = null;
  private manifest: Manifest | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closing = false;

  constructor(options: DirigentClientOptions) {
    super();
    this.opts = {
      reconnect: true,
      reconnectDelay: 3_000,
      reconnectMaxDelay: 30_000,
      heartbeatInterval: 30_000,
      ...options,
    };
  }

  // ── Public accessors ────────────────────────────────────────────────────────

  /** The most recently received manifest, or null if not yet registered. */
  get currentManifest(): Manifest | null {
    return this.manifest;
  }

  /** True while the WebSocket connection is open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Check whether the current manifest permits use of a tool.
   *
   * @param toolId   - Tool identifier, e.g. 'exec', 'file_read', 'web_fetch'
   * @param required - Minimum access level needed. Defaults to 'read' (any non-none access).
   */
  canUseTool(toolId: string, required: 'read' | 'full' = 'read'): boolean {
    if (!this.manifest) return false;
    const tool = this.manifest.tools[toolId];
    if (!tool || tool.access === 'none') return false;
    if (required === 'full') return tool.access === 'full';
    return true; // 'read' or 'full' both satisfy a 'read' requirement
  }

  /**
   * Return the scope constraints for a tool from the current manifest,
   * or null if the tool is not in the manifest.
   */
  getToolScope(toolId: string): object | null {
    if (!this.manifest) return null;
    return this.manifest.tools[toolId]?.scope ?? null;
  }

  /**
   * List all tools currently granted in the manifest (access_level != 'none').
   */
  getAllowedTools(): Record<string, ManifestTool> {
    if (!this.manifest) return {};
    return Object.fromEntries(
      Object.entries(this.manifest.tools).filter(([, t]) => t.access !== 'none'),
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Connect to the Dirigent server and register this agent.
   * Resolves once the 'registered' confirmation is received.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closing = false;
      this._open(resolve, reject);
    });
  }

  /**
   * Disconnect gracefully (disables auto-reconnect for this call).
   */
  disconnect(): Promise<void> {
    this.closing = true;
    this._clearTimers();

    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once('close', () => resolve());
      this.ws.close(1000, 'client disconnect');
    });
  }

  // ── Internal connection logic ───────────────────────────────────────────────

  private _open(onReady?: () => void, onError?: (err: Error) => void): void {
    const url = this._buildWsUrl();

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit('error', e);
      onError?.(e);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.emit('connect');
      this._send({
        type: 'register',
        agent: {
          id: this.opts.agent.id,
          name: this.opts.agent.name,
          type: this.opts.agent.type,
          version: this.opts.agent.version,
          capabilities: this.opts.agent.capabilities,
        },
      });
    });

    this.ws.on('message', (data) => {
      this._handleMessage(data.toString(), onReady);
      // After the first successful message, we no longer need onReady
      onReady = undefined;
    });

    this.ws.on('close', (_code, reason) => {
      this._clearTimers();
      this.emit('disconnect');
      if (!this.closing) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      // 'close' fires after 'error' — reconnect logic lives there
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit('error', e);
      onError?.(e);
      onError = undefined;
    });
  }

  private _handleMessage(raw: string, onReady?: () => void): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'registered': {
        this.manifest = msg.manifest as Manifest;
        this.reconnectAttempts = 0;
        this._startHeartbeat();
        this.emit('registered', { agentId: msg.agentId, manifest: this.manifest });
        this.emit('manifest', this.manifest);
        onReady?.();
        break;
      }

      case 'manifest:update': {
        this.manifest = msg.manifest as Manifest;
        this.emit('manifest', this.manifest);
        break;
      }

      case 'command': {
        const command: AgentCommand = msg.command;
        this.emit('command', { command });
        // Convenience shorthand events
        this.emit(command);
        break;
      }

      case 'pong':
        // heartbeat acknowledged — nothing to do
        break;

      case 'error':
        this.emit('error', new Error(msg.error ?? 'Server error'));
        break;
    }
  }

  private _startHeartbeat(): void {
    this._clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this._send({ type: 'ping' });
    }, this.opts.heartbeatInterval);
  }

  private _clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _clearTimers(): void {
    this._clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this.closing || !this.opts.reconnect) return;

    // Exponential backoff with jitter
    const base = this.opts.reconnectDelay * Math.pow(1.5, this.reconnectAttempts);
    const jitter = Math.random() * 1000;
    const delay = Math.min(base + jitter, this.opts.reconnectMaxDelay);

    this.reconnectAttempts++;
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => this._open(), Math.round(delay));
  }

  private _send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _buildWsUrl(): string {
    let url = this.opts.serverUrl.trim().replace(/\/$/, '');
    // Normalise scheme
    url = url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    if (!/^wss?:\/\//.test(url)) url = 'ws://' + url;
    return url + '/ws';
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAgentClient(options: DirigentClientOptions): DirigentClient {
  return new DirigentClient(options);
}

export default DirigentClient;
