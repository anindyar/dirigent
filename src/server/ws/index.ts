import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { validateAuth, DirigentConfig } from '../config.js';
import { AgentManager } from '../agents/manager.js';
import {
  upsertConnectedAgent,
  updateConnectedAgentHeartbeat,
  updateConnectedAgentStatus,
  markStaleAgentsOffline,
  getConnectedAgent,
  audit,
} from '../db/index.js';

interface WSOptions {
  config: DirigentConfig;
  agentManager: AgentManager;
}

interface Client {
  ws: WebSocket;
  subscriptions: Set<string>;
  authenticated: boolean;
  /** Set when this client is a self-registered agent */
  agentId?: string;
}

// How long without a heartbeat before we consider an agent offline (ms)
const AGENT_TIMEOUT_MS = 60_000;
// How often we sweep for stale agents (ms)
const STALE_SWEEP_INTERVAL_MS = 30_000;

export function registerWebSocket(server: FastifyInstance, options: WSOptions) {
  const { config, agentManager } = options;
  const clients: Map<string, Client> = new Map();

  // WebSocket route
  server.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (connection, _req) => {
      const ws = connection;
      const clientId = Math.random().toString(36).slice(2);

      const client: Client = {
        ws,
        subscriptions: new Set(),
        authenticated: !config.auth.enabled,
      };

      clients.set(clientId, client);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          handleMessage(clientId, client, msg);
        } catch {
          send(ws, { type: 'error', error: 'Invalid JSON' });
        }
      });

      ws.on('close', () => {
        if (client.agentId) {
          updateConnectedAgentStatus(client.agentId, 'offline');
          audit('agent.disconnected', 'system', 'connected_agent', client.agentId, {});
          broadcast('agents', { type: 'agent:disconnected', agentId: client.agentId });
        }
        clients.delete(clientId);
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        if (client.agentId) {
          updateConnectedAgentStatus(client.agentId, 'offline');
          broadcast('agents', { type: 'agent:disconnected', agentId: client.agentId });
        }
        clients.delete(clientId);
      });

      // Send welcome
      send(ws, {
        type: 'welcome',
        clientId,
        authenticated: client.authenticated,
      });
    });
  });

  function handleMessage(clientId: string, client: Client, msg: any) {
    // ── Agent self-registration (no admin auth required) ─────────────────────
    if (msg.type === 'register') {
      handleAgentRegister(clientId, client, msg);
      return;
    }

    // ── Admin auth ────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      if (validateAuth(msg.token, config)) {
        client.authenticated = true;
        send(client.ws, { type: 'auth', success: true });
      } else {
        send(client.ws, { type: 'auth', success: false, error: 'Invalid token' });
      }
      return;
    }

    // ── Ping / heartbeat (agents and dashboard clients) ───────────────────────
    if (msg.type === 'ping') {
      if (client.agentId) {
        const status: 'online' | 'idle' = msg.status === 'idle' ? 'idle' : 'online';
        updateConnectedAgentHeartbeat(client.agentId, status);
        // Propagate status change to dashboard subscribers
        const agent = getConnectedAgent(client.agentId);
        if (agent) {
          broadcast('agents', { type: 'agent:heartbeat', agent });
        }
      }
      send(client.ws, { type: 'pong', ts: Date.now() });
      return;
    }

    // Require auth for all other messages
    if (!client.authenticated) {
      send(client.ws, { type: 'error', error: 'Not authenticated' });
      return;
    }

    switch (msg.type) {
      case 'subscribe:logs':
        if (msg.agentId) {
          client.subscriptions.add(`logs:${msg.agentId}`);
          send(client.ws, { type: 'subscribed', channel: `logs:${msg.agentId}` });
        }
        break;

      case 'unsubscribe:logs':
        if (msg.agentId) {
          client.subscriptions.delete(`logs:${msg.agentId}`);
          send(client.ws, { type: 'unsubscribed', channel: `logs:${msg.agentId}` });
        }
        break;

      case 'subscribe:agents':
        client.subscriptions.add('agents');
        send(client.ws, { type: 'subscribed', channel: 'agents' });
        break;

      case 'unsubscribe:agents':
        client.subscriptions.delete('agents');
        send(client.ws, { type: 'unsubscribed', channel: 'agents' });
        break;

      default:
        send(client.ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
    }
  }

  function handleAgentRegister(clientId: string, client: Client, msg: any) {
    const data = msg.agent;
    if (!data?.id || !data?.name || !data?.type) {
      send(client.ws, {
        type: 'error',
        error: 'register requires agent.id, agent.name, agent.type',
      });
      return;
    }

    // If another client is registered with the same agent id, mark the old
    // connection as replaced (it will be cleaned up on its own close event).
    for (const [otherId, other] of clients) {
      if (otherId !== clientId && other.agentId === data.id) {
        other.agentId = undefined;
      }
    }

    upsertConnectedAgent({
      id: data.id,
      name: data.name,
      type: data.type,
      version: data.version,
      capabilities: data.capabilities,
    });

    client.agentId = data.id;
    // Agents are auto-subscribed to their own control channel
    client.subscriptions.add(`agent:${data.id}`);

    audit('agent.connected', data.id, 'connected_agent', data.id, {
      name: data.name,
      type: data.type,
      version: data.version,
    });

    // Notify dashboard
    const stored = getConnectedAgent(data.id);
    broadcast('agents', { type: 'agent:connected', agent: stored });

    // Respond with confirmation (manifest placeholder for Phase 4)
    send(client.ws, {
      type: 'registered',
      agentId: data.id,
      manifest: {},
    });
  }

  // ── Spawned agent event handlers (existing) ─────────────────────────────────
  agentManager.on('agent:created', (agent) => {
    broadcast('agents', { type: 'agent:created', agent: sanitizeSpawnedAgent(agent) });
  });

  agentManager.on('agent:running', (agent) => {
    broadcast('agents', { type: 'agent:running', agent: sanitizeSpawnedAgent(agent) });
  });

  agentManager.on('agent:stopped', (agent) => {
    broadcast('agents', { type: 'agent:stopped', agent: sanitizeSpawnedAgent(agent) });
  });

  agentManager.on('agent:error', (agent, error) => {
    broadcast('agents', { type: 'agent:error', agent: sanitizeSpawnedAgent(agent), error: error.message });
  });

  agentManager.on('agent:log', (data) => {
    broadcast(`logs:${data.agentId}`, { type: 'agent:log', ...data });
  });

  // ── Stale agent sweep ────────────────────────────────────────────────────────
  const sweepInterval = setInterval(() => {
    const threshold = Date.now() - AGENT_TIMEOUT_MS;
    const staleIds = markStaleAgentsOffline(threshold);
    for (const id of staleIds) {
      broadcast('agents', { type: 'agent:disconnected', agentId: id });
    }
  }, STALE_SWEEP_INTERVAL_MS);

  // Clean up interval when server closes
  server.addHook('onClose', async () => {
    clearInterval(sweepInterval);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function broadcast(channel: string, message: object) {
    for (const client of clients.values()) {
      if (client.authenticated && client.subscriptions.has(channel)) {
        send(client.ws, message);
      }
    }
  }

  function send(ws: WebSocket, message: object) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sanitizeSpawnedAgent(agent: any) {
    return {
      id: agent.id,
      name: agent.name,
      template: agent.template,
      status: agent.status,
      workspace: agent.workspace,
      model: agent.model,
      pid: agent.pid,
      currentTask: agent.currentTask,
      createdAt: agent.createdAt,
      startedAt: agent.startedAt,
      stoppedAt: agent.stoppedAt,
      error: agent.error,
    };
  }
}
