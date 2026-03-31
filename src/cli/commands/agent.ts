import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface AgentOptions {
  template?: string;
  name?: string;
  workspace?: string;
  task?: string;
  model?: string;
  id?: string;
  message?: string;
  force?: boolean;
  follow?: boolean;
  lines?: string;
  all?: boolean;
  json?: boolean;
}

async function getConfig() {
  const dataDir = '.dirigent';
  const configPath = join(process.cwd(), dataDir, 'config.json');

  if (!existsSync(configPath)) {
    console.log(chalk.red('\n❌ Dirigent not initialized. Run `dirigent init` first.\n'));
    process.exit(1);
  }

  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

async function apiCall(
  method: string,
  path: string,
  body?: any
): Promise<any> {
  const config = await getConfig();
  const url = `http://localhost:${config.server.port}/api${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.auth.adminToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || error.message || 'API call failed');
  }

  return res.json();
}

export async function agentCommand(action: string, options: AgentOptions) {
  switch (action) {
    case 'list':
      await listAgents(options);
      break;
    case 'spawn':
      await spawnAgent(options);
      break;
    case 'stop':
      await stopAgent(options);
      break;
    case 'send':
      await sendToAgent(options);
      break;
    case 'logs':
      await agentLogs(options);
      break;
    default:
      console.log(chalk.red(`Unknown action: ${action}`));
  }
}

async function listAgents(options: AgentOptions) {
  try {
    const result = await apiCall('GET', `/agents${options.all ? '?all=true' : ''}`);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.agents.length === 0) {
      console.log(chalk.yellow('\nNo agents found.\n'));
      console.log(chalk.dim('  Spawn one with: dirigent agent spawn claude\n'));
      return;
    }

    console.log(chalk.cyan('\n🤖 Agents\n'));

    for (const agent of result.agents) {
      const icon =
        agent.status === 'running'
          ? chalk.green('●')
          : agent.status === 'idle'
          ? chalk.yellow('●')
          : chalk.red('●');

      console.log(`${icon} ${chalk.bold(agent.name)} ${chalk.dim(`[${agent.id}]`)}`);
      console.log(`  ${chalk.dim('Template:')} ${agent.template}`);
      console.log(`  ${chalk.dim('Status:')} ${agent.status}`);
      console.log(`  ${chalk.dim('Workspace:')} ${agent.workspace || 'N/A'}`);
      if (agent.currentTask) {
        console.log(`  ${chalk.dim('Task:')} ${agent.currentTask.substring(0, 60)}...`);
      }
      console.log('');
    }
  } catch (err: any) {
    console.log(chalk.red(`\n❌ ${err.message}\n`));
    console.log(chalk.dim('  Make sure Dirigent is running: dirigent up\n'));
  }
}

async function spawnAgent(options: AgentOptions) {
  const spinner = ora('Spawning agent...').start();

  try {
    const result = await apiCall('POST', '/agents', {
      template: options.template,
      name: options.name,
      workspace: options.workspace,
      task: options.task,
      model: options.model,
    });

    spinner.succeed(`Agent spawned: ${chalk.bold(result.agent.name)}`);
    console.log(`\n  ${chalk.dim('ID:')} ${result.agent.id}`);
    console.log(`  ${chalk.dim('Template:')} ${result.agent.template}`);
    console.log(`  ${chalk.dim('Workspace:')} ${result.agent.workspace}`);

    if (options.task) {
      console.log(`  ${chalk.dim('Task:')} ${options.task.substring(0, 60)}...`);
    }

    console.log(chalk.dim(`\n  View logs: dirigent agent logs ${result.agent.id}\n`));
  } catch (err: any) {
    spinner.fail('Failed to spawn agent');
    console.log(chalk.red(`\n❌ ${err.message}\n`));
  }
}

async function stopAgent(options: AgentOptions) {
  const spinner = ora('Stopping agent...').start();

  try {
    await apiCall('DELETE', `/agents/${options.id}${options.force ? '?force=true' : ''}`);
    spinner.succeed(`Agent stopped: ${options.id}`);
  } catch (err: any) {
    spinner.fail('Failed to stop agent');
    console.log(chalk.red(`\n❌ ${err.message}\n`));
  }
}

async function sendToAgent(options: AgentOptions) {
  try {
    const result = await apiCall('POST', `/agents/${options.id}/send`, {
      message: options.message,
    });

    console.log(chalk.green(`\n✉️  Message sent to agent ${options.id}\n`));

    if (result.response) {
      console.log(chalk.dim('Response:'));
      console.log(result.response);
    }
  } catch (err: any) {
    console.log(chalk.red(`\n❌ ${err.message}\n`));
  }
}

async function agentLogs(options: AgentOptions) {
  const config = await getConfig();

  if (options.follow) {
    // Stream logs via WebSocket
    const { io } = await import('socket.io-client');
    const socket = io(`http://localhost:${config.server.port}`, {
      auth: { token: config.auth.adminToken },
    });

    socket.on('connect', () => {
      socket.emit('subscribe:logs', { agentId: options.id });
      console.log(chalk.dim(`\nStreaming logs for agent ${options.id}...\n`));
    });

    socket.on('agent:log', (data) => {
      const timestamp = chalk.dim(new Date(data.timestamp).toISOString().split('T')[1].slice(0, 8));
      const level =
        data.level === 'error'
          ? chalk.red('ERR')
          : data.level === 'warn'
          ? chalk.yellow('WRN')
          : chalk.blue('INF');
      console.log(`${timestamp} ${level} ${data.message}`);
    });

    socket.on('disconnect', () => {
      console.log(chalk.dim('\nDisconnected.\n'));
      process.exit(0);
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      socket.disconnect();
    });
  } else {
    // Fetch recent logs
    try {
      const result = await apiCall(
        'GET',
        `/agents/${options.id}/logs?lines=${options.lines || 50}`
      );

      console.log(chalk.dim(`\nLogs for agent ${options.id}:\n`));

      for (const log of result.logs) {
        const timestamp = chalk.dim(new Date(log.timestamp).toISOString().split('T')[1].slice(0, 8));
        const level =
          log.level === 'error'
            ? chalk.red('ERR')
            : log.level === 'warn'
            ? chalk.yellow('WRN')
            : chalk.blue('INF');
        console.log(`${timestamp} ${level} ${log.message}`);
      }

      console.log(chalk.dim(`\n  Stream with: dirigent agent logs ${options.id} -f\n`));
    } catch (err: any) {
      console.log(chalk.red(`\n❌ ${err.message}\n`));
    }
  }
}
