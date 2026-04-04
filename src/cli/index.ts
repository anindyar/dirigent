#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initCommand } from './commands/init.js';
import { upCommand } from './commands/up.js';
import { downCommand } from './commands/down.js';
import { statusCommand } from './commands/status.js';
import { agentCommand } from './commands/agent.js';
import { logsCommand } from './commands/logs.js';
import { configCommand } from './commands/config.js';

// Read version from package.json dynamically
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const version = pkg.version;

const program = new Command();

const banner = `
${chalk.bold.cyan('╔══════════════════════════════════════╗')}
${chalk.bold.cyan('║')}  ${chalk.bold.white('🎭 DIRIGENT')}                          ${chalk.bold.cyan('║')}
${chalk.bold.cyan('║')}  ${chalk.dim('AI Agent Orchestration Platform')}      ${chalk.bold.cyan('║')}
${chalk.bold.cyan('╚══════════════════════════════════════╝')}
`;

program
  .name('dirigent')
  .description('AI Agent Orchestration Platform - Enterprise-grade orchestration for AI coding agents')
  .version(version)
  .addHelpText('beforeAll', banner);

// Core commands
program
  .command('init')
  .description('Initialize a new Dirigent workspace')
  .option('-y, --yes', 'Accept all defaults')
  .option('--port <port>', 'Server port', '3000')
  .option('--data-dir <dir>', 'Data directory', '.dirigent')
  .action(initCommand);

program
  .command('up')
  .description('Start the Dirigent server')
  .option('-d, --detach', 'Run in background')
  .option('--port <port>', 'Override server port')
  .action(upCommand);

program
  .command('down')
  .description('Stop the Dirigent server')
  .option('-f, --force', 'Force stop all agents')
  .action(downCommand);

program
  .command('status')
  .description('Show server and agent status')
  .option('-j, --json', 'Output as JSON')
  .action(statusCommand);

// Agent management
const agent = program
  .command('agent')
  .description('Manage agents');

agent
  .command('list')
  .description('List all agents')
  .option('-a, --all', 'Include stopped agents')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => agentCommand('list', opts));

agent
  .command('spawn <template>')
  .description('Spawn a new agent from template')
  .option('-n, --name <name>', 'Agent name')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-t, --task <task>', 'Initial task')
  .option('--model <model>', 'Model override')
  .action((template, opts) => agentCommand('spawn', { template, ...opts }));

agent
  .command('stop <id>')
  .description('Stop an agent')
  .option('-f, --force', 'Force stop')
  .action((id, opts) => agentCommand('stop', { id, ...opts }));

agent
  .command('send <id> <message>')
  .description('Send a message to an agent')
  .action((id, message) => agentCommand('send', { id, message }));

agent
  .command('logs <id>')
  .description('Stream agent logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <n>', 'Number of lines', '50')
  .action((id, opts) => agentCommand('logs', { id, ...opts }));

// Logs
program
  .command('logs')
  .description('View server logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <n>', 'Number of lines', '100')
  .action(logsCommand);

// Config
program
  .command('config')
  .description('View or edit configuration')
  .option('--get <key>', 'Get a config value')
  .option('--set <key=value>', 'Set a config value')
  .option('--list', 'List all config')
  .option('--edit', 'Open config in editor')
  .action(configCommand);

// Dashboard shortcut
program
  .command('dashboard')
  .alias('ui')
  .description('Open the web dashboard')
  .option('-p, --port <port>', 'Dashboard port')
  .action(async () => {
    const config = await import('../server/config.js').then(m => m.loadConfig());
    console.log(chalk.cyan(`\n🌐 Dashboard: ${chalk.bold(`http://localhost:${config.server.port}`)}\n`));
  });

// Parse and run
program.parse();

// Show help if no command
if (!process.argv.slice(2).length) {
  console.log(banner);
  program.outputHelp();
}
