# Diragent 🎭

> AI Agent Orchestration Platform

Enterprise-grade orchestration for AI coding agents. Self-hosted, simple to deploy, powerful to scale.

[![npm version](https://img.shields.io/npm/v/diragent.svg)](https://www.npmjs.com/package/diragent)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Why Diragent?

Managing multiple AI coding agents (Claude Code, Codex, Cursor, etc.) across projects is chaos. Diragent brings order:

- **One dashboard** to see all your agents
- **Spawn agents on demand** with different models and configs
- **Real-time logs** streaming from every agent
- **Enterprise controls** - authentication, audit trails, resource limits
- **Self-hosted** - your infrastructure, your data, full control

## Requirements

- Node.js 20+
- Linux/macOS (Windows WSL supported)
- AI agent CLIs installed (e.g., `claude`, `codex`)

## Installation

```bash
npm install -g diragent
```

## Quick Start

### 1. Initialize Workspace

```bash
diragent init
```

This creates a `.dirigent/` folder with:
- `config.json` - Server configuration
- `data/` - SQLite database
- `logs/` - Server logs
- `workspaces/` - Agent workspaces

**Important:** Save the admin token shown during init - you'll need it for dashboard access.

### 2. Start the Server

```bash
# Foreground (see logs directly)
diragent up

# Background (daemon mode)
diragent up -d
```

### 3. Access the Dashboard

Open **http://localhost:3000** in your browser.

Login with your admin token (shown during `diragent init`).

The dashboard shows:
- **Stats** - Total agents, running, idle, errors
- **Agent List** - All agents with status indicators
- **Spawn Modal** - Create new agents
- **Agent Details** - Logs, send messages, stop agents

### 4. Spawn Your First Agent

**Via Dashboard:**
1. Click "Spawn Agent"
2. Select template (Claude, Codex, Custom)
3. Optionally set name, workspace, initial task
4. Click "Spawn"

**Via CLI:**
```bash
# Spawn a Claude Code agent
diragent agent spawn claude

# Spawn with custom name and workspace
diragent agent spawn claude --name my-agent --workspace /path/to/project

# Spawn with an initial task
diragent agent spawn claude --task "Build a REST API for user management"

# Spawn Codex agent
diragent agent spawn codex
```

### 5. Interact with Agents

**Send messages:**
```bash
diragent agent send <agent-id> "Add authentication to the API"
```

**View logs:**
```bash
# Last 50 lines
diragent agent logs <agent-id>

# Stream logs in real-time
diragent agent logs <agent-id> -f
```

**Stop an agent:**
```bash
diragent agent stop <agent-id>
```

## Installing AI Agent CLIs

Diragent orchestrates external AI agent CLIs. Install the ones you need:

### Claude Code (Anthropic)
```bash
# Via npm
npm install -g @anthropic-ai/claude-code

# Authenticate
claude auth
```

### Codex (OpenAI)
```bash
npm install -g @openai/codex

# Set API key
export OPENAI_API_KEY=your-key
```

### Custom Agents

Add custom agent templates in `.dirigent/config.json`:

```json
{
  "agents": {
    "templates": {
      "my-custom-agent": {
        "driver": "subprocess",
        "command": ["python", "/path/to/my_agent.py"],
        "env": {
          "MY_API_KEY": "xxx"
        }
      }
    }
  }
}
```

Then spawn: `diragent agent spawn my-custom-agent`

## Configuration

Edit `.dirigent/config.json`:

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "auth": {
    "enabled": true,
    "adminToken": "your-token-here"
  },
  "agents": {
    "maxConcurrent": 10,
    "defaultTimeout": 3600,
    "templates": {
      "claude": {
        "driver": "claude-code",
        "model": "claude-sonnet-4-5"
      },
      "codex": {
        "driver": "codex",
        "model": "codex-1"
      }
    }
  },
  "logging": {
    "level": "info"
  }
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `server.port` | HTTP server port | 3000 |
| `server.host` | Bind address | 0.0.0.0 |
| `auth.enabled` | Enable authentication | true |
| `auth.adminToken` | Admin access token | Generated |
| `agents.maxConcurrent` | Max simultaneous agents | 10 |
| `agents.defaultTimeout` | Agent timeout (seconds) | 3600 |

## CLI Reference

```bash
diragent init [options]      # Initialize workspace
  -y, --yes                  # Accept defaults
  --port <port>              # Server port (default: 3000)

diragent up [options]        # Start server
  -d, --detach               # Run in background

diragent down [options]      # Stop server
  -f, --force                # Force kill all agents

diragent status [options]    # Show status
  -j, --json                 # JSON output

diragent agent list          # List agents
  -a, --all                  # Include stopped
  -j, --json                 # JSON output

diragent agent spawn <template> [options]
  -n, --name <name>          # Agent name
  -w, --workspace <path>     # Working directory
  -t, --task <task>          # Initial task
  --model <model>            # Model override

diragent agent stop <id>     # Stop agent
  -f, --force                # Force kill

diragent agent send <id> <message>  # Send message

diragent agent logs <id>     # View logs
  -f, --follow               # Stream logs
  -n, --lines <n>            # Number of lines

diragent logs [options]      # Server logs
  -f, --follow               # Stream logs

diragent config [options]    # View/edit config
  --get <key>                # Get value
  --set <key=value>          # Set value
  --edit                     # Open in editor
```

## REST API

Base URL: `http://localhost:3000/api`

All endpoints require `Authorization: Bearer <token>` header.

### Endpoints

```
GET  /api/status              # Server status and stats
GET  /api/agents              # List agents (?all=true for stopped)
POST /api/agents              # Spawn agent
GET  /api/agents/:id          # Get agent details
DELETE /api/agents/:id        # Stop agent (?force=true)
POST /api/agents/:id/send     # Send message
GET  /api/agents/:id/logs     # Get logs (?lines=100)
GET  /api/templates           # List available templates
```

### Example: Spawn via API

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "claude",
    "name": "api-builder",
    "task": "Create a REST API"
  }'
```

## WebSocket API

Connect to `ws://localhost:3000/ws` for real-time updates.

```javascript
const socket = io('http://localhost:3000');

// Authenticate
socket.emit('auth', { token: 'YOUR_TOKEN' });

// Subscribe to agent updates
socket.emit('subscribe:agents');

// Subscribe to specific agent logs
socket.emit('subscribe:logs', { agentId: 'xxx' });

// Listen for events
socket.on('agent:created', (data) => console.log('New agent:', data));
socket.on('agent:running', (data) => console.log('Agent started:', data));
socket.on('agent:stopped', (data) => console.log('Agent stopped:', data));
socket.on('agent:log', (data) => console.log('Log:', data));
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Dashboard                            │
│              Real-time UI (WebSocket)                       │
│         http://localhost:3000                               │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Control Plane                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │   REST   │ │WebSocket │ │  SQLite  │ │  Auth &  │       │
│  │   API    │ │  Server  │ │    DB    │ │  Audit   │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Agent Manager                            │
│                                                             │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│   │ Claude  │  │  Codex  │  │ Custom  │  │  ....   │       │
│   │  Agent  │  │  Agent  │  │  Agent  │  │         │       │
│   └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
│                                                             │
│   Each agent runs as a subprocess with:                     │
│   - Isolated workspace                                      │
│   - Captured stdout/stderr → logs                           │
│   - stdin for message passing                               │
└─────────────────────────────────────────────────────────────┘
```

## Troubleshooting

### "Agent not found" error
The agent may have stopped. Check with `diragent agent list -a` to see all agents including stopped ones.

### Dashboard not loading
1. Check server is running: `diragent status`
2. Check port is not in use: `lsof -i :3000`
3. Check logs: `diragent logs`

### Agent won't spawn
1. Ensure the agent CLI is installed (e.g., `which claude`)
2. Check you haven't hit `maxConcurrent` limit
3. Check agent logs for errors

### Authentication issues
Your admin token is in `.dirigent/config.json` under `auth.adminToken`.

## Roadmap

- [ ] Multi-node deployment
- [ ] Agent-to-agent communication
- [ ] Task queuing and scheduling
- [ ] Prometheus metrics
- [ ] RBAC and team management
- [ ] Kubernetes operator

## License

Apache 2.0 - Free to use, modify, and distribute.

## Links

- **npm:** https://www.npmjs.com/package/diragent
- **GitHub:** https://github.com/anindyar/dirigent
- **Issues:** https://github.com/anindyar/dirigent/issues
