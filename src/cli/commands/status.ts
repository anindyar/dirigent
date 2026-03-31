import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import boxen from 'boxen';

interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(options: StatusOptions) {
  const dataDir = '.dirigent';
  const configPath = join(process.cwd(), dataDir, 'config.json');
  const pidPath = join(process.cwd(), dataDir, 'dirigent.pid');

  // Check if initialized
  if (!existsSync(configPath)) {
    if (options.json) {
      console.log(JSON.stringify({ initialized: false, running: false }));
    } else {
      console.log(chalk.yellow('\n⚠️  Dirigent not initialized. Run `dirigent init` first.\n'));
    }
    return;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  let running = false;
  let pid: number | null = null;
  let serverStatus: any = null;

  // Check if running
  if (existsSync(pidPath)) {
    pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
    try {
      process.kill(pid, 0);
      running = true;

      // Try to get server status via API
      try {
        const res = await fetch(`http://localhost:${config.server.port}/api/status`);
        if (res.ok) {
          serverStatus = await res.json();
        }
      } catch {
        // Server might be starting up
      }
    } catch {
      running = false;
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify({
        initialized: true,
        running,
        pid,
        port: config.server.port,
        agents: serverStatus?.agents || [],
        uptime: serverStatus?.uptime || null,
      })
    );
    return;
  }

  // Pretty output
  const statusIcon = running ? chalk.green('●') : chalk.red('●');
  const statusText = running ? chalk.green('Running') : chalk.red('Stopped');

  console.log(
    boxen(
      `${chalk.bold.white('🎭 DIRIGENT STATUS')}\n\n` +
        `${chalk.dim('Status:')}    ${statusIcon} ${statusText}${pid ? chalk.dim(` (PID: ${pid})`) : ''}\n` +
        `${chalk.dim('Port:')}      ${config.server.port}\n` +
        `${chalk.dim('Auth:')}      ${config.auth.enabled ? 'Enabled' : 'Disabled'}\n` +
        (serverStatus
          ? `${chalk.dim('Uptime:')}    ${formatUptime(serverStatus.uptime)}\n` +
            `${chalk.dim('Agents:')}    ${serverStatus.agents.running}/${serverStatus.agents.total} running`
          : ''),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: running ? 'green' : 'red',
      }
    )
  );

  if (running && serverStatus?.agents?.list?.length > 0) {
    console.log(chalk.dim('\nActive Agents:\n'));
    for (const agent of serverStatus.agents.list) {
      const agentIcon = agent.status === 'running' ? chalk.green('●') : chalk.yellow('●');
      console.log(`  ${agentIcon} ${chalk.bold(agent.name)} ${chalk.dim(`(${agent.id})`)}`);
      console.log(`    ${chalk.dim('Template:')} ${agent.template}`);
      console.log(`    ${chalk.dim('Workspace:')} ${agent.workspace}`);
      console.log('');
    }
  }

  if (!running) {
    console.log(chalk.dim(`\n  Start with: ${chalk.cyan('dirigent up')}\n`));
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
