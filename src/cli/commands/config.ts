import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

interface ConfigOptions {
  get?: string;
  set?: string;
  list?: boolean;
  edit?: boolean;
}

export async function configCommand(options: ConfigOptions) {
  const dataDir = '.dirigent';
  const configPath = join(process.cwd(), dataDir, 'config.json');

  if (!existsSync(configPath)) {
    console.log(chalk.red('\n❌ Dirigent not initialized. Run `dirigent init` first.\n'));
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (options.get) {
    const value = getNestedValue(config, options.get);
    if (value === undefined) {
      console.log(chalk.yellow(`\n⚠️  Key not found: ${options.get}\n`));
    } else {
      console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
    }
    return;
  }

  if (options.set) {
    const [key, ...valueParts] = options.set.split('=');
    const value = valueParts.join('=');

    if (!key || value === undefined) {
      console.log(chalk.red('\n❌ Invalid format. Use: --set key=value\n'));
      process.exit(1);
    }

    // Parse value
    let parsedValue: any = value;
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;
    else if (!isNaN(Number(value))) parsedValue = Number(value);
    else {
      try {
        parsedValue = JSON.parse(value);
      } catch {
        // Keep as string
      }
    }

    setNestedValue(config, key, parsedValue);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(chalk.green(`\n✅ Set ${key} = ${JSON.stringify(parsedValue)}\n`));
    console.log(chalk.dim('  Restart Dirigent for changes to take effect: dirigent down && dirigent up\n'));
    return;
  }

  if (options.edit) {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vim';
    const child = spawn(editor, [configPath], {
      stdio: 'inherit',
    });

    child.on('exit', () => {
      console.log(chalk.dim('\n  Restart Dirigent for changes to take effect: dirigent down && dirigent up\n'));
    });
    return;
  }

  // Default: list all config
  console.log(chalk.cyan('\n🔧 Configuration\n'));
  console.log(JSON.stringify(config, null, 2));
  console.log(chalk.dim(`\n  File: ${configPath}\n`));
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const lastKey = keys.pop()!;
  const target = keys.reduce((acc, key) => {
    if (!(key in acc)) acc[key] = {};
    return acc[key];
  }, obj);
  target[lastKey] = value;
}
