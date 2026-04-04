import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';

import { loadConfig, DirigentConfig } from './config.js';
import { initDatabase, getDatabase } from './db/index.js';
import { AgentManager } from './agents/manager.js';
import { registerApiRoutes } from './api/routes.js';
import { registerWebSocket } from './ws/index.js';
import { loadKeyPair } from './manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerOptions {
  port: number;
  configPath: string;
  dataDir: string;
}

let server: ReturnType<typeof Fastify> | null = null;
let agentManager: AgentManager | null = null;
const startTime = Date.now();

export async function startServer(options: ServerOptions) {
  const config = loadConfig(options.configPath);

  // Setup logging
  const logPath = join(options.dataDir, 'logs', 'dirigent.log');
  mkdirSync(dirname(logPath), { recursive: true });

  const logger = pino({
    level: config.logging?.level || 'info',
    transport: {
      targets: [
        {
          target: 'pino-pretty',
          options: { colorize: true },
          level: 'info',
        },
        {
          target: 'pino/file',
          options: { destination: logPath },
          level: 'debug',
        },
      ],
    },
  });

  // Initialize database
  const dbPath = join(options.dataDir, 'data', 'dirigent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  initDatabase(dbPath);

  // Create Fastify server
  server = Fastify({ loggerInstance: logger });

  // Register plugins
  await server.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  await server.register(fastifyWebsocket);

  // Serve dashboard static files
  // From dist/server/ we need to go up 2 levels to package root, then into dashboard/dist
  const dashboardPath = join(__dirname, '..', '..', 'dashboard', 'dist');
  if (existsSync(dashboardPath)) {
    await server.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/',
    });
  }

  // Load RSA key pair (generated during 'diragent init')
  const keysDir = join(options.dataDir, 'keys');
  const keys = loadKeyPair(keysDir);
  if (!keys) {
    logger.warn('No RSA keys found in %s — manifests will be unsigned. Run "diragent init" to generate keys.', keysDir);
  }

  // Initialize agent manager
  agentManager = new AgentManager({
    dataDir: options.dataDir,
    config,
    logger,
  });

  // WebSocket must be registered before routes so pushManifest is available
  const { pushManifest } = registerWebSocket(server, {
    config,
    agentManager,
    privateKey: keys?.privateKey ?? null,
  });

  // Register API routes
  registerApiRoutes(server, {
    config,
    agentManager,
    startTime,
    pushManifest,
  });

  // Health check
  server.get('/health', async () => ({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) }));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);

    // Stop all agents
    if (agentManager) {
      await agentManager.stopAll();
    }

    // Close server
    if (server) {
      await server.close();
    }

    // Close database
    const db = getDatabase();
    if (db) db.close();

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start server
  try {
    await server.listen({ port: options.port, host: config.server?.host || '0.0.0.0' });

    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🎭 DIRIGENT SERVER RUNNING                             ║
║                                                          ║
║   Dashboard:  http://localhost:${options.port.toString().padEnd(25)}║
║   API:        http://localhost:${options.port}/api${' '.repeat(21)}║
║   WebSocket:  ws://localhost:${options.port}/ws${' '.repeat(22)}║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

// Export for direct invocation
if (process.env.DIRIGENT_CONFIG) {
  startServer({
    port: parseInt(process.env.DIRIGENT_PORT || '3000'),
    configPath: process.env.DIRIGENT_CONFIG,
    dataDir: process.env.DIRIGENT_DATA_DIR || '.dirigent',
  });
}
