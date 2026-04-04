import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { nanoid } from 'nanoid';
import { generateKeyPair, saveKeyPair } from '../../server/manifest.js';

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const q = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer || defaultValue || '');
    });
  });
}

async function confirm(question: string, defaultValue = true): Promise<boolean> {
  const answer = await prompt(`${question} (${defaultValue ? 'Y/n' : 'y/N'})`, defaultValue ? 'y' : 'n');
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

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
    const overwrite = options.yes ? true : await confirm('Dirigent is already initialized. Overwrite config?', false);
    if (!overwrite) {
      console.log(chalk.yellow('Aborted.'));
      return;
    }
  }

  // Gather config
  let config = { ...DEFAULT_CONFIG };

  if (!options.yes) {
    const portStr = await prompt('Server port', options.port || '3000');
    const authEnabled = await confirm('Enable authentication?', true);
    const maxAgentsStr = await prompt('Max concurrent agents', '10');

    config.server.port = parseInt(portStr) || 3000;
    config.auth.enabled = authEnabled;
    config.agents.maxConcurrent = parseInt(maxAgentsStr) || 10;
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
      join(dataDir, 'keys'),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // Write config
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Generate RSA key pair for manifest signing
    const keys = generateKeyPair();
    saveKeyPair(join(dataDir, 'keys'), keys);

    // Create .gitignore
    writeFileSync(
      join(dataDir, '.gitignore'),
      `# Dirigent data
data/
logs/
agents/
workspaces/
keys/
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
    console.log(`   ${chalk.cyan('Keys:')} ${join(dataDir, 'keys')} (RSA-2048, manifest signing)`);

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
