# Diragent 🎭

> AI Agent Orchestration Platform

Enterprise-grade orchestration for AI coding agents. Self-hosted, simple to deploy, powerful to scale.

[![npm version](https://img.shields.io/npm/v/diragent.svg)](https://www.npmjs.com/package/diragent)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Quick Start

```bash
# Install globally
npm install -g diragent

# Initialize workspace
diragent init

# Start the server
diragent up

# Open dashboard at http://localhost:3000
```

## Features

- 🤖 **Multi-Agent Orchestration** - Spawn, monitor, and coordinate AI agents
- 🏢 **Enterprise Ready** - Role-based access, audit logs, compliance controls  
- 🔒 **Self-Hosted** - Your infrastructure, your data, your control
- 📊 **Real-time Dashboard** - Monitor all agents from a single pane
- 🔌 **Agent Agnostic** - Works with Claude Code, Codex, and custom agents
- ⚡ **Simple Install** - One command setup on any Linux VM

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Diragent Dashboard                │
│            (React + WebSocket Real-time)            │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                  Control Plane                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ Auth &  │ │ Agent   │ │ Task    │ │ Audit &  │  │
│  │ RBAC    │ │ Registry│ │ Router  │ │ Logging  │  │
│  └─────────┘ └─────────┘ └─────────┘ └──────────┘  │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                  Agent Runtime                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ Agent 1 │ │ Agent 2 │ │ Agent 3 │ │ Agent N  │  │
│  │ (Claude)│ │ (Codex) │ │ (Custom)│ │   ...    │  │
│  └─────────┘ └─────────┘ └─────────┘ └──────────┘  │
└─────────────────────────────────────────────────────┘
```

## CLI Commands

```bash
# Initialization
diragent init              # Initialize workspace (interactive)
diragent init -y           # Initialize with defaults

# Server Management
diragent up                # Start server (foreground)
diragent up -d             # Start server (background)
diragent down              # Stop server
diragent status            # Show server status

# Agent Management
diragent agent list        # List all agents
diragent agent spawn claude              # Spawn Claude Code agent
diragent agent spawn codex               # Spawn Codex agent
diragent agent spawn claude -n myagent   # Spawn with custom name
diragent agent spawn claude -t "task"    # Spawn with initial task
diragent agent stop <id>                 # Stop an agent
diragent agent send <id> "message"       # Send message to agent
diragent agent logs <id>                 # View agent logs
diragent agent logs <id> -f              # Stream agent logs

# Configuration
diragent config            # Show config
diragent config --edit     # Edit config in $EDITOR
diragent config --set key=value

# Logs
diragent logs              # View server logs
diragent logs -f           # Stream server logs
```

## Agent Templates

Built-in templates:

| Template | Driver | Description |
|----------|--------|-------------|
| `claude` | claude-code | Claude Code CLI agent |
| `codex` | codex | OpenAI Codex CLI agent |
| `clawdbot` | clawdbot | Clawdbot headless agent |
| `custom` | subprocess | Custom command |

### Custom Templates

Add to `.dirigent/config.json`:

```json
{
  "agents": {
    "templates": {
      "my-agent": {
        "driver": "subprocess",
        "command": ["python", "my_agent.py"],
        "env": {
          "MY_API_KEY": "xxx"
        }
      }
    }
  }
}
```

## API

REST API available at `http://localhost:3000/api`:

- `GET /api/status` - Server status
- `GET /api/agents` - List agents
- `POST /api/agents` - Spawn agent
- `GET /api/agents/:id` - Get agent details
- `DELETE /api/agents/:id` - Stop agent
- `POST /api/agents/:id/send` - Send message
- `GET /api/agents/:id/logs` - Get logs

WebSocket at `ws://localhost:3000/ws` for real-time updates.

## Client SDK

```typescript
import { DirigentClient } from 'diragent/client';

const client = new DirigentClient({
  url: 'http://localhost:3000',
  token: 'your-admin-token'
});

// Spawn an agent
const agent = await client.spawnAgent({
  template: 'claude',
  name: 'my-agent',
  task: 'Build a REST API'
});

// Subscribe to real-time updates
await client.connect();
client.subscribeToAgents();
client.on('agent:log', (data) => console.log(data));
```

## Configuration

Default config at `.dirigent/config.json`:

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "auth": {
    "enabled": true,
    "adminToken": "generated-on-init"
  },
  "agents": {
    "maxConcurrent": 10,
    "defaultTimeout": 3600
  },
  "logging": {
    "level": "info"
  }
}
```

## License

Apache 2.0 - Free to use, modify, and distribute.

## Commercial Support

Enterprise support, custom integrations, and managed hosting available.

- GitHub: https://github.com/anindyar/dirigent
- npm: https://www.npmjs.com/package/diragent
