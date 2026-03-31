import chalk from 'chalk';
import { existsSync, readFileSync, createReadStream } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

export async function logsCommand(options: LogsOptions) {
  const dataDir = '.dirigent';
  const logPath = join(process.cwd(), dataDir, 'logs', 'dirigent.log');

  if (!existsSync(logPath)) {
    console.log(chalk.yellow('\n⚠️  No logs found.\n'));
    return;
  }

  const lines = parseInt(options.lines || '100');

  if (options.follow) {
    // Use tail -f approach
    const { spawn } = await import('child_process');
    const tail = spawn('tail', ['-f', '-n', lines.toString(), logPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    tail.stdout.on('data', (data) => {
      process.stdout.write(formatLog(data.toString()));
    });

    tail.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
  } else {
    // Read last N lines
    const content = readFileSync(logPath, 'utf-8');
    const allLines = content.trim().split('\n');
    const lastLines = allLines.slice(-lines);

    for (const line of lastLines) {
      console.log(formatLog(line));
    }

    console.log(chalk.dim(`\n  Stream with: dirigent logs -f\n`));
  }
}

function formatLog(line: string): string {
  try {
    // Try to parse as JSON (pino format)
    const parsed = JSON.parse(line);
    const time = chalk.dim(
      new Date(parsed.time).toISOString().split('T')[1].slice(0, 8)
    );
    const level =
      parsed.level <= 20
        ? chalk.dim('DBG')
        : parsed.level <= 30
        ? chalk.blue('INF')
        : parsed.level <= 40
        ? chalk.yellow('WRN')
        : chalk.red('ERR');
    const msg = parsed.msg || '';
    return `${time} ${level} ${msg}`;
  } catch {
    // Return as-is if not JSON
    return line;
  }
}
