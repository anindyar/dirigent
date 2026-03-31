# Dirigent

> AI Agent Orchestration Platform

Enterprise-grade orchestration for AI coding agents. Self-hosted, simple to deploy, powerful to scale.

## Quick Start

```bash
curl -fsSL https://get.dirigent.dev | bash
dirigent init
dirigent up
```

## Features

- 🤖 **Multi-Agent Orchestration** - Spawn, monitor, and coordinate AI agents
- 🏢 **Enterprise Ready** - Role-based access, audit logs, compliance controls  
- 🔒 **Self-Hosted** - Your infrastructure, your data, your control
- 📊 **Real-time Dashboard** - Monitor all agents from a single pane
- 🔌 **Agent Agnostic** - Works with Claude Code, Codex, OpenCode, and more
- ⚡ **Simple Install** - One command setup on any Linux VM

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Dirigent Dashboard                │
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

## License

Apache 2.0 - Free to use, modify, and distribute.

## Commercial Support

Enterprise support, custom integrations, and managed hosting available.
Contact: hello@dirigent.dev

