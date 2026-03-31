import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { nanoid } from 'nanoid';

interface InitOptions {
  yes?: boolean;
  port?: string;
  dataDir?: string;
}

const DEFAULT_CONFIG = {
  version: '1',
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  auth: {
    enabled: true,
    adminToken: '', // Generated during init
  },
  agents: {
    maxConcurrent: 10,
    defaultTimeout: 3600,
    templates: {
      claude: {
        driver: 'claude-code',
        model: 'claude-sonnet-4-5',
        maxTokens: 16000,
      },
      codex: {
        driver: 'codex',
        model: 'codex-1',
      },
      custom: {
        driver: 'subprocess',
        command: [],
      },
    },
  },
  logging: {
    level: 'info',
    format: 'pretty',
    file: 'logs/dirigent.log',
  },
  database: {
    path: 'data/dirigent.db',
  },
};

export async function initCommand(options: InitOptions) {
  console.log(chalk.cyan('\n🎭 Initializing Dirigent workspace\n'));

  const dataDir = options.dataDir || '.dirigent';
  const configPath = join(process.cwd(), dataDir, 'config.json');

  // Check if already initialized
  if (existsSync(configPath)) {
    const { overwrite } = options.yes
      ? { overwrite: true }
      : await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: 'Dirigent is already initialized. Overwrite config?',
            default: false,
          },
        ]);

    if (!overwrite) {
      console.log(chalk.yellow('Aborted.'));
      return;
    }
  }

  // Gather config
  let config = { ...DEFAULT_CONFIG };

  if (!options.yes) {
    const answers = await inquirer.prompt([
      {
        type: 'number',
        name: 'port',
        message: 'Server port:',
        default: parseInt(options.port || '3000'),
      },
      {
        type: 'confirm',
        name: 'authEnabled',
        message: 'Enable authentication?',
        default: true,
      },
      {
        type: 'number',
        name: 'maxAgents',
        message: 'Max concurrent agents:',
        default: 10,
      },
    ]);

    config.server.port = answers.port;
    config.auth.enabled = answers.authEnabled;
    config.agents.maxConcurrent = answers.maxAgents;
  } else {
    config.server.port = parseInt(options.port || '3000');
  }

  // Generate admin token
  config.auth.adminToken = nanoid(32);

  const spinner = ora('Creating workspace...').start();

  try {
    // Create directories
    const dirs = [
      dataDir,
      join(dataDir, 'data'),
      join(dataDir, 'logs'),
      join(dataDir, 'agents'),
      join(dataDir, 'workspaces'),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // Write config
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Create .gitignore
    writeFileSync(
      join(dataDir, '.gitignore'),
      `# Dirigent data
data/
logs/
agents/
workspaces/
*.db
*.db-journal
`
    );

    spinner.succeed('Workspace created');

    console.log(chalk.green('\n✅ Dirigent initialized successfully!\n'));
    console.log(chalk.dim('Configuration:'));
    console.log(`   ${chalk.cyan('Config:')} ${configPath}`);
    console.log(`   ${chalk.cyan('Port:')} ${config.server.port}`);
    console.log(`   ${chalk.cyan('Auth:')} ${config.auth.enabled ? 'Enabled' : 'Disabled'}`);

    if (config.auth.enabled) {
      console.log(chalk.yellow('\n⚠️  Save your admin token (shown only once):'));
      console.log(chalk.bold.white(`   ${config.auth.adminToken}\n`));
    }

    console.log(chalk.dim('Next steps:'));
    console.log(`   ${chalk.cyan('1.')} Start the server: ${chalk.bold('dirigent up')}`);
    console.log(`   ${chalk.cyan('2.')} Open dashboard: ${chalk.bold(`http://localhost:${config.server.port}`)}`);
    console.log(`   ${chalk.cyan('3.')} Spawn an agent: ${chalk.bold('dirigent agent spawn claude')}\n`);
  } catch (err) {
    spinner.fail('Failed to create workspace');
    console.error(chalk.red(err));
    process.exit(1);
  }
}
