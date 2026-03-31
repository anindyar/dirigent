import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { validateAuth, DirigentConfig } from '../config.js';
import { AgentManager } from '../agents/manager.js';

interface WSOptions {
  config: DirigentConfig;
  agentManager: AgentManager;
}

interface Client {
  ws: WebSocket;
  subscriptions: Set<string>;
  authenticated: boolean;
}

export function registerWebSocket(server: FastifyInstance, options: WSOptions) {
  const { config, agentManager } = options;
  const clients: Map<string, Client> = new Map();

  // WebSocket route
  server.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (connection, req) => {
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
        } catch (err) {
          send(ws, { type: 'error', error: 'Invalid JSON' });
        }
      });

      ws.on('close', () => {
        clients.delete(clientId);
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
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
    // Auth
    if (msg.type === 'auth') {
      if (validateAuth(msg.token, config)) {
        client.authenticated = true;
        send(client.ws, { type: 'auth', success: true });
      } else {
        send(client.ws, { type: 'auth', success: false, error: 'Invalid token' });
      }
      return;
    }

    // Require auth for other messages
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

      case 'ping':
        send(client.ws, { type: 'pong', ts: Date.now() });
        break;

      default:
        send(client.ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
    }
  }

  // Agent event handlers
  agentManager.on('agent:created', (agent) => {
    broadcast('agents', { type: 'agent:created', agent: sanitizeAgent(agent) });
  });

  agentManager.on('agent:running', (agent) => {
    broadcast('agents', { type: 'agent:running', agent: sanitizeAgent(agent) });
  });

  agentManager.on('agent:stopped', (agent) => {
    broadcast('agents', { type: 'agent:stopped', agent: sanitizeAgent(agent) });
  });

  agentManager.on('agent:error', (agent, error) => {
    broadcast('agents', { type: 'agent:error', agent: sanitizeAgent(agent), error: error.message });
  });

  agentManager.on('agent:log', (data) => {
    broadcast(`logs:${data.agentId}`, { type: 'agent:log', ...data });
  });

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

  function sanitizeAgent(agent: any) {
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
