# ACC Server — Backend Specification

## Overview

The ACC Server is the root of trust and control plane for the entire agent network. It:
- Maintains the agent registry, hierarchy, tool catalog, and ACL matrix in PostgreSQL
- Manages live agent connections via persistent WebSocket sessions
- Issues signed tool manifests to agents on connection and on policy change
- Streams real-time events (heartbeats, tool calls, alerts) to the dashboard
- Enforces kill switch and live revocation without agent restart

---

## Technology

```
Runtime:       Python 3.11
Framework:     FastAPI 0.110+
WebSocket:     fastapi.websockets + websockets 12+
ORM:           SQLAlchemy 2.0 (async) + Alembic migrations
Database:      PostgreSQL 15 (JSONB for scopes/manifests)
Cache:         Redis 7 (presence, pub/sub, rate limiting)
Auth:          JWT (dashboard users) + mTLS (agent connections)
Crypto:        cryptography 42+ (RSA signing, cert management)
Task queue:    ARQ (async Redis queue for background jobs)
Testing:       pytest + pytest-asyncio + httpx
```

---

## Project Structure

```
server/
├── main.py                    ← FastAPI app factory, lifespan
├── config.py                  ← Settings (pydantic-settings)
├── database.py                ← Async engine, session factory
├── redis_client.py            ← Redis connection pool
│
├── routers/
│   ├── agents.py              ← Agent CRUD, discovery
│   ├── tools.py               ← Tool catalog CRUD
│   ├── permissions.py         ← ACL matrix management
│   ├── agencies.py            ← Agency/hierarchy management
│   ├── audit.py               ← Audit log queries
│   ├── manifests.py           ← Manifest generation + signing
│   └── auth.py                ← JWT auth for dashboard users
│
├── ws/
│   ├── manager.py             ← WebSocket connection manager
│   ├── handlers.py            ← Message type handlers
│   └── protocol.py            ← Message schemas (Pydantic)
│
├── models/
│   ├── agent.py               ← Agent ORM model
│   ├── tool.py                ← Tool ORM model
│   ├── permission.py          ← ACL ORM model
│   ├── manifest.py            ← Manifest ORM model
│   ├── audit_log.py           ← Audit log ORM model
│   └── agency.py              ← Agency/hierarchy ORM model
│
├── services/
│   ├── manifest_service.py    ← Manifest build + signing logic
│   ├── discovery_service.py   ← Network scan (mDNS + port sweep)
│   ├── cert_service.py        ← CA + cert issuance
│   └── alert_service.py       ← Alert routing
│
└── tests/
    ├── test_agents.py
    ├── test_manifests.py
    ├── test_ws.py
    └── conftest.py
```

---

## Database Schema

### agents

```sql
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        VARCHAR(32) UNIQUE NOT NULL,        -- e.g. AEGIS-05
    name            VARCHAR(128) NOT NULL,
    model           VARCHAR(128) NOT NULL,              -- e.g. claude-haiku-4-5
    role            VARCHAR(32) NOT NULL,               -- orchestrator|supervisor|specialist|observer
    tier            INTEGER NOT NULL DEFAULT 3,         -- 1=top, 2=mid, 3=leaf
    parent_id       VARCHAR(32) REFERENCES agents(agent_id),
    status          VARCHAR(32) NOT NULL DEFAULT 'offline',  -- active|busy|offline|paused
    host            VARCHAR(128),                       -- last seen IP
    port            INTEGER,
    capabilities    TEXT[] NOT NULL DEFAULT '{}',       -- capability tags
    api_key_hash    VARCHAR(256),                       -- bcrypt hash
    cert_fingerprint VARCHAR(128),                      -- mTLS cert fingerprint
    uptime_seconds  INTEGER DEFAULT 0,
    total_calls     BIGINT DEFAULT 0,
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_agents_role ON agents(role);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_parent ON agents(parent_id);
```

### tools

```sql
CREATE TABLE tools (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_id         VARCHAR(32) UNIQUE NOT NULL,        -- e.g. AWS, VOX
    name            VARCHAR(128) NOT NULL,
    description     TEXT,
    category        VARCHAR(32) NOT NULL,               -- cloud|hardware|comms|data|ai|security
    risk_level      VARCHAR(16) NOT NULL,               -- critical|high|medium|low
    icon            VARCHAR(64),                        -- emoji or icon name
    operations      TEXT[] NOT NULL DEFAULT '{}',       -- allowed op names
    global_scopes   JSONB NOT NULL DEFAULT '{}',        -- key:value scope constraints (global)
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    total_calls     BIGINT DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tools_category ON tools(category);
CREATE INDEX idx_tools_risk ON tools(risk_level);
```

### agent_tool_grants

```sql
CREATE TABLE agent_tool_grants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    tool_id         VARCHAR(32) NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    access_level    VARCHAR(16) NOT NULL DEFAULT 'none',  -- none|read|full
    scope_overrides JSONB NOT NULL DEFAULT '{}',           -- per-agent scope overrides (merged with global)
    allowed_ops     TEXT[],                                -- null = inherit from tool, else override
    granted_by      VARCHAR(128),                          -- admin user who granted
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,                           -- null = no expiry
    UNIQUE(agent_id, tool_id)
);

CREATE INDEX idx_grants_agent ON agent_tool_grants(agent_id);
CREATE INDEX idx_grants_tool ON agent_tool_grants(tool_id);
```

### agent_acl (agent-to-agent interaction rights)

```sql
CREATE TABLE agent_acl (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    caller_id       VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    callee_id       VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    can_invoke      BOOLEAN NOT NULL DEFAULT FALSE,
    can_query       BOOLEAN NOT NULL DEFAULT FALSE,
    can_observe     BOOLEAN NOT NULL DEFAULT FALSE,
    granted_by      VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(caller_id, callee_id),
    CHECK (caller_id != callee_id)
);
```

### agencies

```sql
CREATE TABLE agencies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128) UNIQUE NOT NULL,
    description     TEXT,
    orchestrator_id VARCHAR(32) REFERENCES agents(agent_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agency_members (
    agency_id       UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    agent_id        VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agency_id, agent_id)
);
```

### manifests

```sql
CREATE TABLE manifests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    version         INTEGER NOT NULL DEFAULT 1,
    payload         JSONB NOT NULL,                     -- full signed manifest payload
    signature       TEXT NOT NULL,                      -- RSA-256 signature (base64)
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    is_current      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_manifests_agent ON manifests(agent_id);
CREATE INDEX idx_manifests_current ON manifests(agent_id, is_current) WHERE is_current = TRUE;
```

### audit_log

```sql
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    event_type      VARCHAR(64) NOT NULL,               -- TOOL_CALL|TOOL_BLOCKED|AGENT_REGISTERED|MANIFEST_ISSUED|KILL_SENT|ACL_CHANGED|etc.
    agent_id        VARCHAR(32),
    tool_id         VARCHAR(32),
    operation       VARCHAR(128),
    scope_context   JSONB,                              -- what scope was active at call time
    outcome         VARCHAR(16) NOT NULL,               -- ok|blocked|error
    block_reason    TEXT,
    duration_ms     INTEGER,
    ip_address      VARCHAR(64),
    session_id      VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_agent ON audit_log(agent_id);
CREATE INDEX idx_audit_type ON audit_log(event_type);
CREATE INDEX idx_audit_time ON audit_log(created_at DESC);
CREATE INDEX idx_audit_outcome ON audit_log(outcome) WHERE outcome != 'ok';
```

### dashboard_users

```sql
CREATE TABLE dashboard_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(256) UNIQUE NOT NULL,
    name            VARCHAR(128),
    password_hash   VARCHAR(256) NOT NULL,
    role            VARCHAR(32) NOT NULL DEFAULT 'operator',  -- admin|operator|viewer
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ
);
```

---

## REST API

### Base URL: `/api/v1`

### Authentication

All dashboard REST endpoints require a JWT bearer token obtained from `POST /api/v1/auth/login`.

Agent WebSocket connections use mTLS (client certificate) + agent API key (passed in connection headers).

---

### Agents

```
GET    /agents                     List all agents (with status, last_seen)
GET    /agents/{agent_id}          Get single agent detail
POST   /agents                     Register agent manually
PATCH  /agents/{agent_id}          Update agent metadata / role / tier
DELETE /agents/{agent_id}          Deregister agent
GET    /agents/{agent_id}/tools    Get tool grants for agent
GET    /agents/{agent_id}/manifest Get current active manifest
POST   /agents/{agent_id}/kill     Send kill signal via WebSocket
POST   /agents/{agent_id}/pause    Send pause signal
POST   /agents/{agent_id}/resume   Send resume signal
POST   /agents/{agent_id}/refresh-manifest   Reissue manifest, push to agent
GET    /agents/{agent_id}/audit    Audit log filtered to this agent
```

#### POST /agents (manual registration)
```json
{
  "agent_id": "AEGIS-07",
  "name": "New Specialist",
  "model": "mistral:7b",
  "role": "specialist",
  "tier": 3,
  "parent_id": "AEGIS-02",
  "capabilities": ["summarization", "classification"]
}
```

---

### Tools

```
GET    /tools                      List all tools
GET    /tools/{tool_id}            Get tool detail including global scopes
POST   /tools                      Register new tool
PATCH  /tools/{tool_id}            Update tool (scopes, ops, risk level)
DELETE /tools/{tool_id}            Remove tool from catalog
GET    /tools/{tool_id}/grants     List all agent grants for this tool
GET    /tools/{tool_id}/audit      Tool call history
```

#### POST /tools
```json
{
  "tool_id": "SLACK",
  "name": "Slack API",
  "description": "Send messages to Slack channels and DMs",
  "category": "comms",
  "risk_level": "medium",
  "icon": "💬",
  "operations": ["chat.postMessage", "channels.list", "users.info"],
  "global_scopes": {
    "workspace": "techimbue.slack.com",
    "allowed_channels": "#ops-*, #alerts-*",
    "max_messages_per_hour": "100",
    "no_dm_to_external": "true"
  }
}
```

---

### Permissions (Tool Grants)

```
GET    /permissions/matrix                       Full agent×tool matrix
PUT    /permissions/grant                        Grant/update tool access for agent
DELETE /permissions/revoke                       Revoke tool from agent
GET    /permissions/agent/{agent_id}             All grants for agent
GET    /permissions/tool/{tool_id}               All agents with this tool
PATCH  /permissions/scopes                       Update per-agent scope overrides
```

#### PUT /permissions/grant
```json
{
  "agent_id": "AEGIS-05",
  "tool_id": "RASPI",
  "access_level": "full",
  "scope_overrides": {
    "allowed_pins": "3,5,7,11,13",
    "safe_mode": "enabled"
  },
  "allowed_ops": ["gpio:read", "gpio:write", "i2c:read"],
  "expires_at": null
}
```

---

### Agent ACL (Agent-to-Agent)

```
GET    /acl/matrix                              Full caller×callee matrix
PUT    /acl                                     Set agent-to-agent permissions
GET    /acl/{caller_id}                         What agents can caller_id invoke?
GET    /acl/callee/{callee_id}                  Who can invoke callee_id?
```

---

### Agencies

```
GET    /agencies                               List agencies
POST   /agencies                               Create agency
GET    /agencies/{id}                          Get agency with member list
PATCH  /agencies/{id}                          Update agency (name, orchestrator)
DELETE /agencies/{id}                          Dissolve agency
POST   /agencies/{id}/members                  Add agent to agency
DELETE /agencies/{id}/members/{agent_id}       Remove agent from agency
GET    /agencies/{id}/hierarchy                Return tree representation
```

---

### Discovery

```
POST   /discovery/scan                         Trigger active network scan
GET    /discovery/results                      Get latest scan results
POST   /discovery/register-discovered          Register a discovered endpoint
GET    /discovery/unregistered                 Endpoints found but not in registry
```

#### POST /discovery/scan
```json
{
  "subnet": "192.168.1.0/24",
  "ports": [11434, 8080, 3000, 9090, 5000],
  "mdns": true,
  "timeout_seconds": 15
}
```

---

### Manifests

```
GET    /manifests/{agent_id}/current           Get active manifest for agent
GET    /manifests/{agent_id}/history           Manifest version history
POST   /manifests/{agent_id}/reissue           Force manifest regeneration + push
POST   /manifests/bulk-reissue                 Reissue for all agents (e.g. after tool change)
```

---

### Audit

```
GET    /audit                                  Paginated audit log (filter by agent, tool, outcome, time)
GET    /audit/blocked                          All blocked tool calls
GET    /audit/alerts                           High-severity events
GET    /audit/stats                            Aggregate stats (calls/hour, block rate, top agents)
```

---

## WebSocket Protocol

### Endpoint: `wss://acc-server/ws/agent/{agent_id}`

Connection requires:
- mTLS client certificate (issued by ACC CA)
- Header: `X-Agent-API-Key: <key>`

### Message Format

All messages are JSON with a `type` field:

```json
{
  "type": "MESSAGE_TYPE",
  "session_id": "sess_abc123",
  "timestamp": "2026-03-31T14:32:00Z",
  "payload": { ... }
}
```

### Agent → ACC Messages

#### REGISTER
Sent immediately after connection established.
```json
{
  "type": "REGISTER",
  "payload": {
    "agent_id": "AEGIS-05",
    "model": "claude-haiku-4-5",
    "host": "192.168.1.101",
    "port": 8080,
    "capabilities": ["python", "javascript", "sql"],
    "openclaw_version": "1.4.2-acc",
    "acc_kernel_version": "1.0.0",
    "signature": "<sha256 of payload signed with agent private key>"
  }
}
```

#### HEARTBEAT
Sent every 10 seconds.
```json
{
  "type": "HEARTBEAT",
  "payload": {
    "agent_id": "AEGIS-05",
    "status": "active",
    "uptime_seconds": 3600,
    "calls_total": 421,
    "calls_blocked": 2,
    "manifest_version": 3,
    "memory_mb": 512,
    "active_task": "summarizing SEC filings"
  }
}
```

#### TOOL_CALL_LOG
Sent by the ACC kernel relay on every tool invocation (before execution).
```json
{
  "type": "TOOL_CALL_LOG",
  "payload": {
    "tool_id": "RASPI",
    "operation": "gpio:write",
    "params": { "pin": 11, "value": "HIGH" },
    "outcome": "ok",
    "duration_ms": 21,
    "manifest_version": 3
  }
}
```

#### TOOL_CALL_BLOCKED
Sent when relay blocks a tool call.
```json
{
  "type": "TOOL_CALL_BLOCKED",
  "payload": {
    "tool_id": "DOCKERCTL",
    "operation": "container:start",
    "params": { "name": "nginx" },
    "block_reason": "tool_not_in_manifest",
    "manifest_version": 3
  }
}
```

---

### ACC → Agent Messages

#### REGISTER_ACK
```json
{
  "type": "REGISTER_ACK",
  "payload": {
    "status": "ok",
    "session_id": "sess_9f2a1c",
    "message": "Registered as AEGIS-05 · role: specialist"
  }
}
```

#### MANIFEST
Sent after REGISTER_ACK and whenever policy changes.
```json
{
  "type": "MANIFEST",
  "payload": {
    "agent_id": "AEGIS-05",
    "version": 3,
    "issued_at": "2026-03-31T14:32:00Z",
    "expires_at": "2026-03-31T15:32:00Z",
    "tools": [
      {
        "tool_id": "RASPI",
        "access_level": "full",
        "operations": ["gpio:read", "gpio:write", "i2c:read"],
        "scopes": {
          "allowed_pins": "3,5,7,11,13",
          "safe_mode": "enabled",
          "gpio_write_confirm": "required"
        }
      },
      {
        "tool_id": "WEBFETCH",
        "access_level": "full",
        "operations": ["search", "fetch-url", "extract-text"],
        "scopes": {
          "blocked_domains": "*.gov,*.mil",
          "max_pages_per_call": "5"
        }
      },
      {
        "tool_id": "AWS",
        "access_level": "read",
        "operations": ["s3:Get*", "ec2:Describe*", "cloudwatch:GetMetrics"],
        "scopes": {
          "regions": "us-east-1",
          "s3_buckets": "techimbue-prod-*",
          "iam_boundary": "ReadOnlyAccess"
        }
      }
    ],
    "acl": {
      "can_invoke": ["AEGIS-02"],
      "can_be_invoked_by": ["AEGIS-02", "AEGIS-01"]
    },
    "signature": "acc-rsa-256:base64encoded..."
  }
}
```

#### HEARTBEAT_ACK
Standard response — no change.
```json
{ "type": "HEARTBEAT_ACK", "payload": { "status": "ok" } }
```

#### CONFIG_UPDATE
Push new scope constraints without full manifest reissue.
```json
{
  "type": "CONFIG_UPDATE",
  "payload": {
    "tool_id": "VOX",
    "updated_scopes": { "tx_window": "08:00-20:00 GST" },
    "effective_immediately": true
  }
}
```

#### PAUSE
```json
{
  "type": "PAUSE",
  "payload": {
    "reason": "Maintenance window 14:00-14:30",
    "resume_at": "2026-03-31T14:30:00Z"
  }
}
```

#### KILL
```json
{
  "type": "KILL",
  "payload": {
    "reason": "Policy violation — repeated scope bypass attempts",
    "grace_seconds": 5,
    "logged_by": "admin@techimbue.com"
  }
}
```

---

## WebSocket Connection Manager

File: `server/ws/manager.py`

```python
from fastapi import WebSocket
from typing import Dict
import asyncio
import json
import redis.asyncio as redis

class AgentConnectionManager:
    """
    Manages all live agent WebSocket connections.
    Persists presence state to Redis for dashboard visibility.
    """

    def __init__(self, redis_client: redis.Redis):
        self.connections: Dict[str, WebSocket] = {}   # agent_id → websocket
        self.sessions: Dict[str, str] = {}            # agent_id → session_id
        self.redis = redis_client

    async def connect(self, agent_id: str, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.connections[agent_id] = websocket
        self.sessions[agent_id] = session_id
        await self.redis.setex(
            f"agent:presence:{agent_id}",
            60,                          # TTL 60s, refreshed by heartbeat
            json.dumps({"status": "connected", "session_id": session_id})
        )
        await self.redis.publish("agent_events", json.dumps({
            "type": "AGENT_CONNECTED", "agent_id": agent_id
        }))

    async def disconnect(self, agent_id: str):
        self.connections.pop(agent_id, None)
        self.sessions.pop(agent_id, None)
        await self.redis.delete(f"agent:presence:{agent_id}")
        await self.redis.publish("agent_events", json.dumps({
            "type": "AGENT_DISCONNECTED", "agent_id": agent_id
        }))

    async def send(self, agent_id: str, message: dict):
        ws = self.connections.get(agent_id)
        if ws:
            await ws.send_json(message)

    async def broadcast(self, message: dict):
        for ws in self.connections.values():
            await ws.send_json(message)

    async def send_manifest(self, agent_id: str, manifest: dict):
        await self.send(agent_id, {"type": "MANIFEST", "payload": manifest})

    async def send_kill(self, agent_id: str, reason: str, grace_seconds: int = 5):
        await self.send(agent_id, {
            "type": "KILL",
            "payload": {"reason": reason, "grace_seconds": grace_seconds}
        })

    def is_connected(self, agent_id: str) -> bool:
        return agent_id in self.connections

    def connected_count(self) -> int:
        return len(self.connections)
```

---

## Manifest Service

File: `server/services/manifest_service.py`

```python
import json
import base64
from datetime import datetime, timedelta
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from sqlalchemy.ext.asyncio import AsyncSession
from models import agent as agent_model, tool as tool_model
from models import agent_tool_grants, agent_acl

class ManifestService:
    """
    Builds and signs tool manifests for agents.
    The manifest is the single source of truth for what an agent can do.
    """

    def __init__(self, private_key_pem: bytes, ttl_seconds: int = 3600):
        self.private_key = serialization.load_pem_private_key(private_key_pem, password=None)
        self.ttl_seconds = ttl_seconds

    async def build_manifest(self, agent_id: str, db: AsyncSession) -> dict:
        """
        Build a manifest by joining agent grants + tool definitions + scope overrides.
        Global scopes from tool definition are merged with per-agent overrides.
        Per-agent overrides take precedence.
        """
        grants = await db.execute(
            """
            SELECT
                atg.tool_id,
                atg.access_level,
                atg.scope_overrides,
                atg.allowed_ops,
                atg.expires_at,
                t.global_scopes,
                t.operations AS tool_ops,
                t.enabled
            FROM agent_tool_grants atg
            JOIN tools t ON t.tool_id = atg.tool_id
            WHERE atg.agent_id = :agent_id
              AND atg.access_level != 'none'
              AND t.enabled = TRUE
              AND (atg.expires_at IS NULL OR atg.expires_at > NOW())
            """,
            {"agent_id": agent_id}
        )

        tools = []
        for row in grants:
            # Merge scopes: global base + agent overrides on top
            merged_scopes = {**row.global_scopes, **row.scope_overrides}

            # Operations: agent override if set, else inherit from tool definition
            ops = row.allowed_ops if row.allowed_ops else row.tool_ops

            # Read access strips write operations
            if row.access_level == "read":
                ops = [op for op in ops if
                       any(op.startswith(p) for p in ["Get", "List", "Describe",
                                                        "Read", "search", "fetch",
                                                        "receive", "scan", "read",
                                                        "list", "get", "describe"])]

            tools.append({
                "tool_id": row.tool_id,
                "access_level": row.access_level,
                "operations": ops,
                "scopes": merged_scopes
            })

        # Agent ACL
        acl_rows = await db.execute(
            "SELECT callee_id FROM agent_acl WHERE caller_id = :id AND can_invoke = TRUE",
            {"id": agent_id}
        )
        can_invoke = [r.callee_id for r in acl_rows]

        invokable_by = await db.execute(
            "SELECT caller_id FROM agent_acl WHERE callee_id = :id AND can_invoke = TRUE",
            {"id": agent_id}
        )
        can_be_invoked_by = [r.caller_id for r in invokable_by]

        now = datetime.utcnow()
        manifest = {
            "agent_id": agent_id,
            "version": await self._next_version(agent_id, db),
            "issued_at": now.isoformat() + "Z",
            "expires_at": (now + timedelta(seconds=self.ttl_seconds)).isoformat() + "Z",
            "tools": tools,
            "acl": {
                "can_invoke": can_invoke,
                "can_be_invoked_by": can_be_invoked_by
            }
        }

        manifest["signature"] = self._sign(manifest)
        return manifest

    def _sign(self, manifest: dict) -> str:
        # Remove signature field before signing
        payload = {k: v for k, v in manifest.items() if k != "signature"}
        data = json.dumps(payload, sort_keys=True).encode()
        sig = self.private_key.sign(data, padding.PKCS1v15(), hashes.SHA256())
        return "acc-rsa-256:" + base64.b64encode(sig).decode()

    async def _next_version(self, agent_id: str, db: AsyncSession) -> int:
        result = await db.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM manifests WHERE agent_id = :id",
            {"id": agent_id}
        )
        return result.scalar()

    def verify_signature(self, manifest: dict, public_key_pem: bytes) -> bool:
        from cryptography.hazmat.primitives.asymmetric import padding as apad
        from cryptography.hazmat.primitives import serialization as ser
        pub = ser.load_pem_public_key(public_key_pem)
        sig_str = manifest.get("signature", "")
        if not sig_str.startswith("acc-rsa-256:"):
            return False
        sig = base64.b64decode(sig_str[12:])
        payload = {k: v for k, v in manifest.items() if k != "signature"}
        data = json.dumps(payload, sort_keys=True).encode()
        try:
            pub.verify(sig, data, apad.PKCS1v15(), hashes.SHA256())
            return True
        except Exception:
            return False
```

---

## Discovery Service

File: `server/services/discovery_service.py`

```python
import asyncio
import socket
import json
from typing import List, Dict
from zeroconf.asyncio import AsyncZeroconf, AsyncServiceBrowser
import aiohttp

class DiscoveryService:
    """
    Two-mode agent discovery:
    1. mDNS passive: listens for _agent._tcp.local service announcements
    2. Active scan: sweeps subnet on known agent ports
    """

    KNOWN_PORTS = [11434, 8080, 3000, 9090, 5000, 7860, 3001]

    async def scan_subnet(self, subnet: str, ports: List[int] = None,
                          timeout: float = 2.0) -> List[Dict]:
        ports = ports or self.KNOWN_PORTS
        results = []

        import ipaddress
        network = ipaddress.IPv4Network(subnet, strict=False)

        async def probe(ip: str, port: int):
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(ip, port), timeout=timeout
                )
                writer.close()
                await writer.wait_closed()

                # Try to fetch agent metadata from /acc/meta endpoint
                meta = await self._fetch_meta(ip, port)
                results.append({
                    "ip": ip, "port": port,
                    "reachable": True,
                    "meta": meta
                })
            except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
                pass

        tasks = [probe(str(ip), port)
                 for ip in network.hosts()
                 for port in ports]

        # Batch with semaphore to avoid overwhelming the network
        sem = asyncio.Semaphore(64)
        async def bounded(task):
            async with sem:
                await task

        await asyncio.gather(*[bounded(t) for t in tasks], return_exceptions=True)
        return results

    async def _fetch_meta(self, ip: str, port: int) -> dict:
        """
        Try to GET /acc/meta from a discovered endpoint.
        OpenClaw-ACC agents expose this endpoint automatically.
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"http://{ip}:{port}/acc/meta",
                    timeout=aiohttp.ClientTimeout(total=3)
                ) as resp:
                    if resp.status == 200:
                        return await resp.json()
        except Exception:
            pass
        return {}

    async def mdns_listen(self, duration_seconds: int = 30) -> List[Dict]:
        """
        Listen for mDNS _agent._tcp.local service announcements.
        OpenClaw-ACC agents broadcast this on startup.
        """
        discovered = []

        class AgentListener:
            def add_service(self, zc, type_, name):
                info = zc.get_service_info(type_, name)
                if info:
                    discovered.append({
                        "name": name,
                        "ip": socket.inet_ntoa(info.addresses[0]),
                        "port": info.port,
                        "properties": {k.decode(): v.decode()
                                       for k, v in info.properties.items()}
                    })
            def remove_service(self, zc, type_, name): pass
            def update_service(self, zc, type_, name): pass

        aiozc = AsyncZeroconf()
        browser = AsyncServiceBrowser(aiozc.zeroconf, "_agent._tcp.local.", AgentListener())
        await asyncio.sleep(duration_seconds)
        await aiozc.async_close()
        return discovered
```

---

## main.py

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import redis.asyncio as aioredis

from database import engine, Base
from redis_client import get_redis
from ws.manager import AgentConnectionManager
from routers import agents, tools, permissions, agencies, audit, manifests, auth
import config

ws_manager: AgentConnectionManager = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    redis = aioredis.from_url(config.settings.REDIS_URL)
    app.state.ws_manager = AgentConnectionManager(redis)

    yield

    # Shutdown
    await redis.close()

app = FastAPI(
    title="Agency Control Center API",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,        prefix="/api/v1/auth",        tags=["auth"])
app.include_router(agents.router,      prefix="/api/v1/agents",      tags=["agents"])
app.include_router(tools.router,       prefix="/api/v1/tools",       tags=["tools"])
app.include_router(permissions.router, prefix="/api/v1/permissions", tags=["permissions"])
app.include_router(agencies.router,    prefix="/api/v1/agencies",    tags=["agencies"])
app.include_router(audit.router,       prefix="/api/v1/audit",       tags=["audit"])
app.include_router(manifests.router,   prefix="/api/v1/manifests",   tags=["manifests"])

# WebSocket endpoint — agents connect here
from ws.handlers import agent_ws_endpoint
app.add_websocket_route("/ws/agent/{agent_id}", agent_ws_endpoint)

# Dashboard live-events stream (SSE)
from routers.events import events_router
app.include_router(events_router, prefix="/api/v1/events", tags=["events"])
```

---

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql+asyncpg://acc:password@localhost:5432/acc_db

# Redis
REDIS_URL=redis://localhost:6379/0

# Security
ACC_SECRET_KEY=<random 64-char hex>
ACC_PRIVATE_KEY_PATH=/etc/acc/certs/acc_private.pem
ACC_PUBLIC_KEY_PATH=/etc/acc/certs/acc_public.pem
ACC_CA_CERT_PATH=/etc/acc/certs/ca.crt
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=480

# Server
HOST=0.0.0.0
PORT=9443
CORS_ORIGINS=["http://localhost:5173","https://acc.techimbue.internal"]

# Manifest
MANIFEST_TTL_SECONDS=3600
MANIFEST_WARN_BEFORE_EXPIRY=300

# Features
ENABLE_MDNS_DISCOVERY=true
ENABLE_ACTIVE_SCAN=true
HEARTBEAT_TIMEOUT_SECONDS=30
```
