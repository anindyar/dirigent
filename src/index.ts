// Dirigent - AI Agent Orchestration Platform

export { startServer, type ServerOptions } from './server/index.js';
export { loadConfig, validateAuth, type DirigentConfig, type AgentTemplate } from './server/config.js';
export { AgentManager, type Agent } from './server/agents/manager.js';
export * from './server/db/index.js';
