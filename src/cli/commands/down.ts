import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import treeKill from 'tree-kill';

interface DownOptions {
  force?: boolean;
}

export async function downCommand(options: DownOptions) {
  const dataDir = '.dirigent';
  const pidPath = join(process.cwd(), dataDir, 'dirigent.pid');

  if (!existsSync(pidPath)) {
    console.log(chalk.yellow('\n⚠️  Dirigent is not running.\n'));
    return;
  }

  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
  const spinner = ora('Stopping Dirigent...').start();

  try {
    // Check if process is running
    try {
      process.kill(pid, 0);
    } catch {
      spinner.warn('Dirigent was not running (stale PID file)');
      unlinkSync(pidPath);
      return;
    }

    // Stop the server (and all child agents)
    await new Promise<void>((resolve, reject) => {
      const signal = options.force ? 'SIGKILL' : 'SIGTERM';
      treeKill(pid, signal, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Remove PID file
    unlinkSync(pidPath);

    spinner.succeed('Dirigent stopped');
    console.log(chalk.green('\n✅ Dirigent has been stopped.\n'));
  } catch (err) {
    spinner.fail('Failed to stop Dirigent');
    console.error(chalk.red(err));
    
    if (options.force) {
      // Force remove PID file
      try {
        unlinkSync(pidPath);
      } catch {}
    }
    process.exit(1);
  }
}
