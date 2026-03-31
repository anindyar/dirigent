import { EventEmitter } from 'events';
import { nanoid } from 'nanoid';
import { spawn, ChildProcess } from 'child_process';
import treeKill from 'tree-kill';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { Logger } from 'pino';

import { DirigentConfig, AgentTemplate } from '../config.js';
import { insertAgent, updateAgent, getAgent, getAgents, insertLog, getLogs, audit } from '../db/index.js';

export interface Agent {
  id: string;
  name: string;
  template: string;
  status: 'created' | 'starting' | 'running' | 'idle' | 'stopping' | 'stopped' | 'error';
  workspace?: string;
  model?: string;
  pid?: number;
  process?: ChildProcess;
  currentTask?: string;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  error?: string;
}

interface ManagerOptions {
  dataDir: string;
  config: DirigentConfig;
  logger: Logger;
}

export class AgentManager extends EventEmitter {
  private agents: Map<string, Agent> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private dataDir: string;
  private config: DirigentConfig;
  private logger: Logger;

  constructor(options: ManagerOptions) {
    super();
    this.dataDir = options.dataDir;
    this.config = options.config;
    this.logger = options.logger;

    // Load existing agents from database
    this.loadAgents();
  }

  private loadAgents() {
    const dbAgents = getAgents(false);
    for (const dbAgent of dbAgents) {
      // Only load non-running agents; running agents will need to be respawned
      if (dbAgent.status !== 'stopped') {
        this.agents.set(dbAgent.id, {
          id: dbAgent.id,
          name: dbAgent.name,
          template: dbAgent.template,
          status: 'stopped', // Reset to stopped since we restarted
          workspace: dbAgent.workspace,
          model: dbAgent.model,
          createdAt: dbAgent.created_at * 1000,
        });

        // Update database
        updateAgent(dbAgent.id, { status: 'stopped' });
      }
    }
  }

  async spawn(options: {
    template: string;
    name?: string;
    workspace?: string;
    task?: string;
    model?: string;
  }): Promise<Agent> {
    const { template, name, workspace, task, model } = options;

    // Get template config
    const templateConfig = this.config.agents.templates[template];
    if (!templateConfig) {
      throw new Error(`Unknown template: ${template}`);
    }

    // Check max concurrent
    const runningCount = Array.from(this.agents.values()).filter(
      (a) => a.status === 'running' || a.status === 'starting'
    ).length;

    if (runningCount >= this.config.agents.maxConcurrent) {
      throw new Error(`Max concurrent agents (${this.config.agents.maxConcurrent}) reached`);
    }

    // Create agent
    const id = nanoid(12);
    const agentName = name || `${template}-${id.slice(0, 6)}`;
    const agentWorkspace = workspace || join(this.dataDir, 'workspaces', id);

    // Ensure workspace exists
    if (!existsSync(agentWorkspace)) {
      mkdirSync(agentWorkspace, { recursive: true });
    }

    const agent: Agent = {
      id,
      name: agentName,
      template,
      status: 'created',
      workspace: agentWorkspace,
      model: model || templateConfig.model,
      currentTask: task,
      createdAt: Date.now(),
    };

    // Save to database
    insertAgent({
      id: agent.id,
      name: agent.name,
      template: agent.template,
      workspace: agent.workspace,
      model: agent.model,
    });

    audit('agent.created', null, 'agent', id, { name: agentName, template });

    this.agents.set(id, agent);
    this.emit('agent:created', agent);

    // Start the agent process
    await this.startAgent(agent, templateConfig, task);

    return agent;
  }

  private async startAgent(agent: Agent, template: AgentTemplate, initialTask?: string) {
    agent.status = 'starting';
    updateAgent(agent.id, { status: 'starting' });
    this.emit('agent:starting', agent);

    try {
      const { command, env } = this.buildCommand(agent, template);

      this.logger.info({ agentId: agent.id, command }, 'Starting agent');

      const proc = spawn(command[0], command.slice(1), {
        cwd: agent.workspace,
        env: {
          ...process.env,
          ...env,
          DIRIGENT_AGENT_ID: agent.id,
          DIRIGENT_AGENT_NAME: agent.name,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      agent.pid = proc.pid;
      agent.process = proc;
      agent.status = 'running';
      agent.startedAt = Date.now();

      updateAgent(agent.id, {
        status: 'running',
        pid: proc.pid,
        started_at: Math.floor(Date.now() / 1000),
      });

      this.processes.set(agent.id, proc);

      // Handle stdout
      proc.stdout?.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          this.log(agent.id, 'info', message);
        }
      });

      // Handle stderr
      proc.stderr?.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          this.log(agent.id, 'error', message);
        }
      });

      // Handle exit
      proc.on('exit', (code, signal) => {
        this.logger.info({ agentId: agent.id, code, signal }, 'Agent exited');

        agent.status = code === 0 ? 'stopped' : 'error';
        agent.stoppedAt = Date.now();
        if (code !== 0) {
          agent.error = `Exited with code ${code}`;
        }

        updateAgent(agent.id, {
          status: agent.status,
          stopped_at: Math.floor(Date.now() / 1000),
          error: agent.error || null,
        });

        this.processes.delete(agent.id);
        this.emit('agent:stopped', agent);

        audit('agent.stopped', null, 'agent', agent.id, { code, signal });
      });

      proc.on('error', (err) => {
        this.logger.error({ agentId: agent.id, err }, 'Agent process error');
        agent.status = 'error';
        agent.error = err.message;

        updateAgent(agent.id, { status: 'error', error: err.message });
        this.emit('agent:error', agent, err);
      });

      this.emit('agent:running', agent);
      audit('agent.started', null, 'agent', agent.id, { pid: proc.pid });

      // Send initial task if provided
      if (initialTask && proc.stdin) {
        proc.stdin.write(initialTask + '\n');
      }
    } catch (err: any) {
      agent.status = 'error';
      agent.error = err.message;
      updateAgent(agent.id, { status: 'error', error: err.message });
      this.emit('agent:error', agent, err);
      throw err;
    }
  }

  private buildCommand(agent: Agent, template: AgentTemplate): { command: string[]; env: Record<string, string> } {
    const env: Record<string, string> = { ...template.env };

    switch (template.driver) {
      case 'claude-code':
        return {
          command: ['claude', '--dangerously-skip-permissions'],
          env: {
            ...env,
            ANTHROPIC_MODEL: agent.model || template.model || 'claude-sonnet-4-5',
          },
        };

      case 'codex':
        return {
          command: ['codex', '--model', agent.model || template.model || 'codex-1'],
          env,
        };

      case 'clawdbot':
        return {
          command: ['clawdbot', 'agent', '--headless'],
          env: {
            ...env,
            CLAWDBOT_MODEL: agent.model || template.model || 'claude-sonnet-4-5',
          },
        };

      case 'subprocess':
        if (!template.command || template.command.length === 0) {
          throw new Error('subprocess driver requires command');
        }
        return { command: template.command, env };

      default:
        throw new Error(`Unknown driver: ${template.driver}`);
    }
  }

  async stop(id: string, force = false): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }

    if (agent.status !== 'running' && agent.status !== 'starting') {
      return;
    }

    agent.status = 'stopping';
    this.emit('agent:stopping', agent);

    const proc = this.processes.get(id);
    if (proc && proc.pid) {
      await new Promise<void>((resolve, reject) => {
        treeKill(proc.pid!, force ? 'SIGKILL' : 'SIGTERM', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    audit('agent.stop_requested', null, 'agent', id, { force });
  }

  async stopAll(): Promise<void> {
    const promises = Array.from(this.agents.values())
      .filter((a) => a.status === 'running' || a.status === 'starting')
      .map((a) => this.stop(a.id, true));

    await Promise.allSettled(promises);
  }

  async send(id: string, message: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }

    if (agent.status !== 'running') {
      throw new Error(`Agent is not running: ${agent.status}`);
    }

    const proc = this.processes.get(id);
    if (!proc || !proc.stdin) {
      throw new Error('Agent process not available');
    }

    proc.stdin.write(message + '\n');
    this.log(id, 'info', `[USER] ${message}`);

    audit('agent.message_sent', null, 'agent', id, { length: message.length });
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  list(includeStopped = false): Agent[] {
    const agents = Array.from(this.agents.values());
    if (includeStopped) return agents;
    return agents.filter((a) => a.status !== 'stopped');
  }

  log(agentId: string, level: string, message: string) {
    insertLog({ agentId, level, message });
    this.emit('agent:log', { agentId, level, message, timestamp: Date.now() });
  }

  getLogs(agentId: string, limit = 100) {
    return getLogs(agentId, limit);
  }

  getStats() {
    const agents = Array.from(this.agents.values());
    return {
      total: agents.length,
      running: agents.filter((a) => a.status === 'running').length,
      idle: agents.filter((a) => a.status === 'idle').length,
      stopped: agents.filter((a) => a.status === 'stopped').length,
      error: agents.filter((a) => a.status === 'error').length,
    };
  }
}
