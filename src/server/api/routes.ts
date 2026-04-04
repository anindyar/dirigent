import type { FastifyInstance } from 'fastify';
import { validateAuth, DirigentConfig } from '../config.js';
import { AgentManager } from '../agents/manager.js';
import {
  getAgents,
  audit,
  getConnectedAgents,
  getConnectedAgent,
  getConnectedAgentStats,
  updateConnectedAgentStatus,
} from '../db/index.js';

interface RouteOptions {
  config: DirigentConfig;
  agentManager: AgentManager;
  startTime: number;
}

export function registerApiRoutes(server: FastifyInstance, options: RouteOptions) {
  const { config, agentManager, startTime } = options;

  // Auth middleware
  server.addHook('onRequest', async (request, reply) => {
    // Skip auth for health check
    if (request.url === '/health') return;

    // Skip auth for dashboard routes
    if (!request.url.startsWith('/api')) return;

    if (config.auth.enabled) {
      const authHeader = request.headers.authorization;
      const token = authHeader?.replace('Bearer ', '');

      if (!token || !validateAuth(token, config)) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
    }
  });

  // Status
  server.get('/api/status', async () => {
    const spawnedStats = agentManager.getStats();
    const connectedStats = getConnectedAgentStats();
    const agents = agentManager.list(false);

    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      agents: {
        ...spawnedStats,
        list: agents.map((a) => ({
          id: a.id,
          name: a.name,
          template: a.template,
          status: a.status,
          workspace: a.workspace,
          currentTask: a.currentTask,
        })),
      },
      connectedAgents: connectedStats,
    };
  });

  // List agents
  server.get<{ Querystring: { all?: string } }>('/api/agents', async (request) => {
    const includeStopped = request.query.all === 'true';
    const agents = agentManager.list(includeStopped);

    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        template: a.template,
        status: a.status,
        workspace: a.workspace,
        model: a.model,
        pid: a.pid,
        currentTask: a.currentTask,
        createdAt: a.createdAt,
        startedAt: a.startedAt,
        stoppedAt: a.stoppedAt,
        error: a.error,
      })),
    };
  });

  // Spawn agent
  server.post<{
    Body: {
      template: string;
      name?: string;
      workspace?: string;
      task?: string;
      model?: string;
    };
  }>('/api/agents', async (request, reply) => {
    const { template, name, workspace, task, model } = request.body;

    if (!template) {
      reply.code(400).send({ error: 'template is required' });
      return;
    }

    try {
      const agent = await agentManager.spawn({ template, name, workspace, task, model });

      return {
        agent: {
          id: agent.id,
          name: agent.name,
          template: agent.template,
          status: agent.status,
          workspace: agent.workspace,
          model: agent.model,
        },
      };
    } catch (err: any) {
      reply.code(400).send({ error: err.message });
    }
  });

  // Get agent
  server.get<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const agent = agentManager.get(request.params.id);

    if (!agent) {
      reply.code(404).send({ error: 'Agent not found' });
      return;
    }

    return {
      agent: {
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
      },
    };
  });

  // Stop agent
  server.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/api/agents/:id',
    async (request, reply) => {
      const agent = agentManager.get(request.params.id);

      if (!agent) {
        reply.code(404).send({ error: 'Agent not found' });
        return;
      }

      const force = request.query.force === 'true';

      try {
        await agentManager.stop(request.params.id, force);
        return { ok: true };
      } catch (err: any) {
        reply.code(500).send({ error: err.message });
      }
    }
  );

  // Send message to agent
  server.post<{ Params: { id: string }; Body: { message: string } }>(
    '/api/agents/:id/send',
    async (request, reply) => {
      const agent = agentManager.get(request.params.id);

      if (!agent) {
        reply.code(404).send({ error: 'Agent not found' });
        return;
      }

      const { message } = request.body;

      if (!message) {
        reply.code(400).send({ error: 'message is required' });
        return;
      }

      try {
        await agentManager.send(request.params.id, message);
        return { ok: true };
      } catch (err: any) {
        reply.code(400).send({ error: err.message });
      }
    }
  );

  // Get agent logs
  server.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/api/agents/:id/logs',
    async (request, reply) => {
      const agent = agentManager.get(request.params.id);

      if (!agent) {
        reply.code(404).send({ error: 'Agent not found' });
        return;
      }

      const limit = parseInt(request.query.lines || '100');
      const logs = agentManager.getLogs(request.params.id, limit);

      return { logs };
    }
  );

  // Templates
  server.get('/api/templates', async () => {
    return {
      templates: Object.entries(config.agents.templates).map(([name, template]) => ({
        name,
        driver: template.driver,
        model: template.model,
      })),
    };
  });

  // ── Connected (self-registered) agents ───────────────────────────────────────

  // List connected agents
  server.get<{ Querystring: { all?: string } }>('/api/agents/connected', async (request) => {
    const includeOffline = request.query.all === 'true';
    const agents = getConnectedAgents(includeOffline);
    return { agents };
  });

  // Get single connected agent
  server.get<{ Params: { id: string } }>('/api/agents/connected/:id', async (request, reply) => {
    const agent = getConnectedAgent(request.params.id);
    if (!agent) {
      reply.code(404).send({ error: 'Agent not found' });
      return;
    }
    return { agent };
  });

  // Manually mark a connected agent offline (deregister)
  server.delete<{ Params: { id: string } }>('/api/agents/connected/:id', async (request, reply) => {
    const agent = getConnectedAgent(request.params.id);
    if (!agent) {
      reply.code(404).send({ error: 'Agent not found' });
      return;
    }
    updateConnectedAgentStatus(request.params.id, 'offline');
    audit('agent.deregistered', 'admin', 'connected_agent', request.params.id, {});
    return { ok: true };
  });

  // ── Audit log ─────────────────────────────────────────────────────────────────

  server.get<{ Querystring: { limit?: string } }>('/api/audit', async (request) => {
    // TODO: Implement audit log retrieval
    return { logs: [] };
  });
}
