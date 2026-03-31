import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const AgentTemplateSchema = z.object({
  driver: z.string(),
  model: z.string().optional(),
  maxTokens: z.number().optional(),
  command: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const ConfigSchema = z.object({
  version: z.string().default('1'),
  server: z
    .object({
      port: z.number().default(3000),
      host: z.string().default('0.0.0.0'),
    })
    .default({}),
  auth: z
    .object({
      enabled: z.boolean().default(true),
      adminToken: z.string().optional(),
      apiKeys: z.array(z.string()).optional(),
    })
    .default({}),
  agents: z
    .object({
      maxConcurrent: z.number().default(10),
      defaultTimeout: z.number().default(3600),
      templates: z.record(AgentTemplateSchema).default({}),
    })
    .default({}),
  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      format: z.enum(['pretty', 'json']).default('pretty'),
      file: z.string().optional(),
    })
    .default({}),
  database: z
    .object({
      path: z.string().default('data/dirigent.db'),
    })
    .default({}),
});

export type DirigentConfig = z.infer<typeof ConfigSchema>;
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

let cachedConfig: DirigentConfig | null = null;

export function loadConfig(configPath?: string): DirigentConfig {
  if (cachedConfig) return cachedConfig;

  const path = configPath || findConfigPath();

  if (!path || !existsSync(path)) {
    // Return defaults
    cachedConfig = ConfigSchema.parse({});
    return cachedConfig;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  cachedConfig = ConfigSchema.parse(parsed);

  return cachedConfig;
}

function findConfigPath(): string | null {
  const candidates = [
    join(process.cwd(), '.dirigent', 'config.json'),
    join(process.cwd(), 'dirigent.json'),
    join(process.env.HOME || '', '.dirigent', 'config.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function validateAuth(token: string, config: DirigentConfig): boolean {
  if (!config.auth.enabled) return true;

  // Check admin token
  if (config.auth.adminToken && token === config.auth.adminToken) return true;

  // Check API keys
  if (config.auth.apiKeys?.includes(token)) return true;

  return false;
}
