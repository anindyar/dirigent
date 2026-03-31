import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

interface UpOptions {
  detach?: boolean;
  port?: string;
}

export async function upCommand(options: UpOptions) {
  const dataDir = '.dirigent';
  const configPath = join(process.cwd(), dataDir, 'config.json');
  const pidPath = join(process.cwd(), dataDir, 'dirigent.pid');

  // Check if initialized
  if (!existsSync(configPath)) {
    console.log(chalk.red('\n❌ Dirigent not initialized. Run `dirigent init` first.\n'));
    process.exit(1);
  }

  // Check if already running
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
    try {
      process.kill(pid, 0);
      console.log(chalk.yellow(`\n⚠️  Dirigent is already running (PID: ${pid})`));
      console.log(chalk.dim('   Use `dirigent down` to stop it first.\n'));
      return;
    } catch {
      // Process not running, remove stale PID file
    }
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const port = options.port || config.server.port;

  console.log(chalk.cyan('\n🎭 Starting Dirigent server...\n'));

  const spinner = ora('Starting server...').start();

  try {
    // Get the path to the server entry point
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const serverPath = join(__dirname, '..', '..', 'server', 'index.js');

    const env = {
      ...process.env,
      DIRIGENT_PORT: port.toString(),
      DIRIGENT_CONFIG: configPath,
      DIRIGENT_DATA_DIR: join(process.cwd(), dataDir),
    };

    if (options.detach) {
      // Run in background
      const child = spawn(process.execPath, [serverPath], {
        detached: true,
        stdio: 'ignore',
        env,
      });

      child.unref();
      writeFileSync(pidPath, child.pid!.toString());

      spinner.succeed(`Server started (PID: ${child.pid})`);
      console.log(chalk.green(`\n✅ Dirigent is running\n`));
      console.log(`   ${chalk.cyan('Dashboard:')} http://localhost:${port}`);
      console.log(`   ${chalk.cyan('API:')} http://localhost:${port}/api`);
      console.log(`   ${chalk.cyan('WebSocket:')} ws://localhost:${port}/ws\n`);
      console.log(chalk.dim(`   Stop with: dirigent down\n`));
    } else {
      // Run in foreground
      spinner.succeed('Server starting...');

      const { startServer } = await import('../../server/index.js');
      await startServer({
        port: parseInt(port),
        configPath,
        dataDir: join(process.cwd(), dataDir),
      });
    }
  } catch (err) {
    spinner.fail('Failed to start server');
    console.error(chalk.red(err));
    process.exit(1);
  }
}
