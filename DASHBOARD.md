# ACC Dashboard — Frontend Specification

## Overview

The ACC Dashboard is a React 18 + TypeScript + Vite SPA. It is the primary interface for administrators to manage the agent network: register agents, define the hierarchy, manage tool grants, configure scope restrictions, and monitor live activity.

---

## Tech Stack

```
Framework:      React 18 + TypeScript 5
Build:          Vite 5
State:          Zustand (global) + React Query (server state)
UI Library:     shadcn/ui + Radix UI primitives
Styling:        Tailwind CSS 3
Charts:         Recharts
Live updates:   EventSource (SSE) for dashboard events + WebSocket passthrough
HTTP client:    Axios with interceptors
Routing:        React Router v6
Auth:           JWT stored in httpOnly cookie (not localStorage)
Icons:          Lucide React
```

---

## Project Structure

```
dashboard/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── router.tsx
│   │
│   ├── api/
│   │   ├── client.ts          ← Axios instance, auth interceptors
│   │   ├── agents.ts
│   │   ├── tools.ts
│   │   ├── permissions.ts
│   │   ├── agencies.ts
│   │   ├── audit.ts
│   │   └── manifests.ts
│   │
│   ├── store/
│   │   ├── agents.ts          ← Zustand: agent list, live presence
│   │   ├── tools.ts           ← Zustand: tool catalog
│   │   ├── events.ts          ← Zustand: live event stream
│   │   └── auth.ts            ← Zustand: current user
│   │
│   ├── hooks/
│   │   ├── useAgents.ts
│   │   ├── useTools.ts
│   │   ├── useLiveEvents.ts   ← SSE connection hook
│   │   ├── usePermissions.ts
│   │   └── useAudit.ts
│   │
│   ├── views/
│   │   ├── Overview.tsx       ← Landing: metrics + agent grid
│   │   ├── Hierarchy.tsx      ← Interactive org chart
│   │   ├── ToolRegistry.tsx   ← Tool catalog with risk + grants
│   │   ├── AgentMatrix.tsx    ← Agent × Tool permission matrix
│   │   ├── ScopeEditor.tsx    ← Per-tool, per-agent scope config
│   │   ├── AgentACL.tsx       ← Agent-to-agent interaction matrix
│   │   ├── Agencies.tsx       ← Agency management
│   │   ├── Discovery.tsx      ← Network scan + register new agents
│   │   ├── AuditLog.tsx       ← Paginated + filtered audit trail
│   │   ├── AgentDetail.tsx    ← Single agent full profile
│   │   └── Settings.tsx       ← ACC server config, user management
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Shell.tsx      ← App shell: sidebar + topbar
│   │   │   ├── Sidebar.tsx
│   │   │   └── TopBar.tsx
│   │   ├── agents/
│   │   │   ├── AgentCard.tsx
│   │   │   ├── AgentBadge.tsx
│   │   │   ├── StatusDot.tsx
│   │   │   └── AgentForm.tsx
│   │   ├── tools/
│   │   │   ├── ToolCard.tsx
│   │   │   ├── RiskBadge.tsx
│   │   │   ├── ScopeTable.tsx
│   │   │   └── ToolForm.tsx
│   │   ├── permissions/
│   │   │   ├── PermissionCell.tsx
│   │   │   └── AccessLevelPicker.tsx
│   │   ├── hierarchy/
│   │   │   └── OrgTree.tsx    ← D3-based or SVG tree
│   │   ├── audit/
│   │   │   ├── AuditRow.tsx
│   │   │   └── AuditFilters.tsx
│   │   └── shared/
│   │       ├── ConfirmDialog.tsx
│   │       ├── LiveBadge.tsx
│   │       └── MetricCard.tsx
│   │
│   └── types/
│       ├── agent.ts
│       ├── tool.ts
│       ├── permission.ts
│       ├── manifest.ts
│       └── audit.ts
│
├── public/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

---

## TypeScript Types

### `types/agent.ts`

```typescript
export type AgentStatus = 'active' | 'busy' | 'offline' | 'paused';
export type AgentRole = 'orchestrator' | 'supervisor' | 'specialist' | 'observer';

export interface Agent {
  id: string;
  agent_id: string;             // e.g. AEGIS-05
  name: string;
  model: string;
  role: AgentRole;
  tier: number;
  parent_id: string | null;
  status: AgentStatus;
  host: string | null;
  port: number | null;
  capabilities: string[];
  uptime_seconds: number;
  total_calls: number;
  last_seen_at: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface AgentWithGrants extends Agent {
  tool_grants: ToolGrant[];
  acl: AgentACL;
}

export interface AgentACL {
  can_invoke: string[];
  can_be_invoked_by: string[];
}
```

### `types/tool.ts`

```typescript
export type ToolCategory = 'cloud' | 'hardware' | 'comms' | 'data' | 'ai' | 'security';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type AccessLevel = 'none' | 'read' | 'full';

export interface Tool {
  id: string;
  tool_id: string;              // e.g. AWS, VOX, RASPI
  name: string;
  description: string;
  category: ToolCategory;
  risk_level: RiskLevel;
  icon: string;
  operations: string[];
  global_scopes: Record<string, string>;
  enabled: boolean;
  total_calls: number;
  created_at: string;
}

export interface ToolGrant {
  id: string;
  agent_id: string;
  tool_id: string;
  access_level: AccessLevel;
  scope_overrides: Record<string, string>;
  allowed_ops: string[] | null;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
}
```

### `types/audit.ts`

```typescript
export type AuditOutcome = 'ok' | 'blocked' | 'error';

export interface AuditEntry {
  id: number;
  event_type: string;
  agent_id: string | null;
  tool_id: string | null;
  operation: string | null;
  scope_context: Record<string, unknown> | null;
  outcome: AuditOutcome;
  block_reason: string | null;
  duration_ms: number | null;
  ip_address: string | null;
  session_id: string | null;
  created_at: string;
}
```

---

## Views Specification

### Overview (`/`)

**Purpose:** Real-time network health at a glance.

**Metrics row (top):**
- Agents online / total
- Tool calls today
- Blocked calls today (with % of total)
- Active agencies

**Agent grid:**
- One `AgentCard` per registered agent
- Cards show: name, model, role badge, status dot, capabilities, call count
- Click → navigate to `AgentDetail`
- Sort/filter: by status, role, tier

**Live event feed (sidebar or bottom strip):**
- Last 10 events from SSE stream
- Color coded: green=ok, red=blocked, amber=alert
- Auto-scrolls

---

### Hierarchy (`/hierarchy`)

**Purpose:** Visual org chart of the agency.

**Component: `OrgTree`**
- Render agents as nodes in a tree based on `parent_id`
- Node color: role-based (orchestrator=blue, supervisor=amber, specialist=gray)
- Node status: dot indicator (active=green, busy=amber, offline=gray)
- Click node → slide-out panel with agent summary + quick actions
- Quick actions: Push manifest, Pause, Kill, View audit

**Agency selector:**
- If multiple agencies, show agency switcher
- Each agency renders its own tree
- Unassigned agents shown in separate "unassigned" section

**Layout:**
- Auto-layout using D3 `d3.tree()` or a React tree library (e.g. `react-d3-tree`)
- Responsive: horizontal on desktop, vertical on mobile

---

### Tool Registry (`/tools`)

**Purpose:** View and manage the full tool catalog.

**Layout:**
- Left: filterable list of tools (filter by category, risk level, search)
- Right: detail panel when tool selected

**Tool card (list):**
- Icon, name, risk badge, category tag
- Ops count, agent grant count, call count today
- Click to expand full detail

**Tool detail panel:**
- Full description
- Global scope constraints (key/value table, each row editable)
- Operations list with checkboxes
- Agent grant summary: which agents have what access
- Quick action: "Add tool grant" → opens grant dialog
- Audit button → filtered audit log for this tool

**Add Tool dialog:**
- Form: tool_id, name, description, category, risk_level, icon
- Dynamic scope builder: add/remove key-value pairs
- Operations list: add/remove strings with wildcard support

---

### Agent × Tool Matrix (`/matrix`)

**Purpose:** The main operational view for managing tool access across all agents.

**Layout:**
- Full-width table
- Rows: agents (with role badge and model in subtitle)
- Columns: tools (with icon and risk badge in header)
- Cell: access level indicator — None (—), Read (R), Full (✓)

**Cell interaction:**
- Click to cycle: none → read → full
- Right-click / hold → context menu: "Edit scopes", "Set expiry", "Revoke"
- Changed cells are highlighted until saved
- "Save changes" button in sticky footer — changes are batched, not instant (prevents accidental grants)

**Risk warnings:**
- Granting full access to a critical-risk tool → confirm dialog with risk explanation
- Grant count per agent shown in row header
- Tool grant count shown in column header

**Keyboard shortcuts:**
- N = none, R = read, F = full for focused cell
- Esc = cancel pending changes

---

### Scope Editor (`/scopes`)

**Purpose:** Fine-grained scope configuration per tool per agent.

**Layout:**
- Two-column: tool list (left) + scope editor (right)
- Tool list shows: tool icon, name, scope rule count, risk badge
- Selecting a tool loads its scope editor

**Scope editor:**
- Global scopes section: key-value pairs from `tools.global_scopes`
  - Each row: key (monospace), value (editable), "scope applies to all agents" label
  - Add / remove rows
- Per-agent overrides section
  - Agent selector (dropdown or grid of agent pills)
  - Selecting agent shows: current access level + override form
  - Override form: inherits global values as placeholders, agent can override each
  - "Reset to global" button per field
  - Save saves only that agent's overrides

**Scope validation:**
- Known scope keys get type-aware editors:
  - `regions`, `allowed_pins`, `allowed_domains` → tag input (comma separated)
  - `max_*` → numeric input
  - `*_required`, `enabled`, `safe_mode` → toggle
  - `tx_window` → time range picker
  - `allowed_channels` → text with pattern hint
- Unknown keys → plain text input

---

### Agent ACL (`/acl`)

**Purpose:** Control which agents can invoke which other agents.

**Layout:**
- Same N×N matrix pattern as tool matrix
- Rows = caller, Columns = callee
- Diagonal = disabled (self-invocation)
- Cell: three toggles — Invoke | Query | Observe — can combine

**Permission levels:**
- `Invoke` — agent can send task requests to the other agent
- `Query` — agent can read status/state from the other agent
- `Observe` — agent is in the audit trail for the other agent's calls

---

### Agencies (`/agencies`)

**Purpose:** Create and manage named agencies (groups of agents with a hierarchy).

**Agency card:**
- Name, orchestrator agent, member count, creation date
- Action buttons: Edit, Dissolve, View hierarchy

**Create agency:**
- Name field
- Select orchestrator (must be role=orchestrator or supervisor)
- Add members with drag-to-tier assignment

---

### Discovery (`/discovery`)

**Purpose:** Find agents running on the network that aren't yet registered.

**Scan config:**
- Subnet input (default: auto-detect local subnet)
- Port list (pre-filled with defaults)
- mDNS toggle
- Timeout slider

**Scan output:**
- Animated log output during scan
- Results table: IP, port, model (if meta endpoint responded), status, match to registry
- "Register" button for unrecognised endpoints
- Register dialog: pre-fills from /acc/meta response, admin fills in role/tier/parent

---

### Audit Log (`/audit`)

**Purpose:** Full visibility into all inter-agent and tool call events.

**Filters:**
- Date range picker
- Agent filter (multi-select)
- Tool filter (multi-select)
- Outcome filter: all | ok | blocked | error
- Event type filter
- Free text search (searches operation + scope_context)

**Table columns:**
- Timestamp (relative + absolute on hover)
- Agent → Tool or Agent → Agent
- Operation
- Scope context (truncated, expand on click)
- Outcome badge
- Duration (ms)

**Blocked events:**
- Highlighted in red
- "Investigate" button → opens agent detail + scope editor side by side

**Export:**
- Export filtered results as CSV
- Date range limited to 30 days per export

---

### Agent Detail (`/agents/:agent_id`)

**Purpose:** Full profile and management panel for a single agent.

**Sections:**
1. **Identity** — agent_id, name, model, role, tier, parent, capabilities, host/port, cert fingerprint
2. **Status** — live status, uptime, calls today, last seen, current task (from heartbeat)
3. **Current manifest** — version, issued_at, expires_at, list of active tools with scopes
4. **Tool grants** — same as matrix row for this agent; inline editable
5. **Agent ACL** — who can invoke this agent, who it can invoke
6. **Audit trail** — last 50 events for this agent
7. **Actions** — Push manifest, Pause, Resume, Kill, Deregister

---

## Live Events (SSE)

### Hook: `useLiveEvents`

```typescript
// hooks/useLiveEvents.ts
import { useEffect } from 'react';
import { useEventStore } from '../store/events';
import { useAgentStore } from '../store/agents';

export function useLiveEvents() {
  const addEvent = useEventStore(s => s.addEvent);
  const updateAgentStatus = useAgentStore(s => s.updateStatus);

  useEffect(() => {
    const es = new EventSource('/api/v1/events/stream', {
      withCredentials: true
    });

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      addEvent(event);

      // Update agent presence in real time
      if (event.type === 'AGENT_CONNECTED') {
        updateAgentStatus(event.agent_id, 'active');
      } else if (event.type === 'AGENT_DISCONNECTED') {
        updateAgentStatus(event.agent_id, 'offline');
      } else if (event.type === 'HEARTBEAT') {
        updateAgentStatus(event.agent_id, event.payload.status);
      }
    };

    es.onerror = () => {
      // Auto-reconnect is built into EventSource
      console.warn('SSE connection error — browser will retry');
    };

    return () => es.close();
  }, []);
}
```

### ACC Server SSE Endpoint

```python
# server/routers/events.py
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
import asyncio
import json
import redis.asyncio as aioredis

events_router = APIRouter()

@events_router.get("/stream")
async def event_stream(request: Request):
    """
    Server-Sent Events endpoint for dashboard live updates.
    Subscribes to Redis pub/sub channel and streams to browser.
    """
    redis: aioredis.Redis = request.app.state.redis

    async def generate():
        pubsub = redis.pubsub()
        await pubsub.subscribe("agent_events", "tool_events", "audit_events")
        try:
            while True:
                if await request.is_disconnected():
                    break
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg:
                    yield f"data: {msg['data'].decode()}\n\n"
                else:
                    yield ": keepalive\n\n"   # SSE keepalive comment
        finally:
            await pubsub.unsubscribe()
            await pubsub.close()

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )
```

---

## State Management

### Zustand: `store/agents.ts`

```typescript
import { create } from 'zustand';
import { Agent, AgentStatus } from '../types/agent';

interface AgentStore {
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;
  updateStatus: (agent_id: string, status: AgentStatus) => void;
  updateAgent: (agent_id: string, partial: Partial<Agent>) => void;
  getAgent: (agent_id: string) => Agent | undefined;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: [],

  setAgents: (agents) => set({ agents }),

  updateStatus: (agent_id, status) =>
    set(state => ({
      agents: state.agents.map(a =>
        a.agent_id === agent_id ? { ...a, status } : a
      )
    })),

  updateAgent: (agent_id, partial) =>
    set(state => ({
      agents: state.agents.map(a =>
        a.agent_id === agent_id ? { ...a, ...partial } : a
      )
    })),

  getAgent: (agent_id) => get().agents.find(a => a.agent_id === agent_id),
}));
```

---

## Key UI Behaviours

### Permission Matrix Cell

```typescript
// components/permissions/PermissionCell.tsx
import { useState } from 'react';
import { AccessLevel } from '../../types/tool';

const ORDER: AccessLevel[] = ['none', 'read', 'full'];

const DISPLAY: Record<AccessLevel, { label: string; className: string }> = {
  none:  { label: '—', className: 'bg-secondary text-muted opacity-40' },
  read:  { label: 'R',  className: 'bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-200' },
  full:  { label: '✓',  className: 'bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-200' },
};

interface Props {
  agentId: string;
  toolId: string;
  current: AccessLevel;
  riskLevel: string;
  onChange: (agentId: string, toolId: string, level: AccessLevel) => void;
}

export function PermissionCell({ agentId, toolId, current, riskLevel, onChange }: Props) {
  const [pending, setPending] = useState(false);

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

    // Warn before granting full on critical tools
    if (next === 'full' && riskLevel === 'critical') {
      if (!confirm(`Granting full access to a critical-risk tool. Are you sure?`)) return;
    }

    onChange(agentId, toolId, next);
    setPending(true);
    setTimeout(() => setPending(false), 2000); // visual feedback
  };

  const d = DISPLAY[current];
  return (
    <button
      onClick={cycle}
      className={`w-12 h-8 rounded-md text-xs font-medium transition-all
        ${d.className} ${pending ? 'ring-2 ring-amber-400' : ''}`}
    >
      {d.label}
    </button>
  );
}
```

### Risk Badge

```typescript
// components/tools/RiskBadge.tsx
import { RiskLevel } from '../../types/tool';

const styles: Record<RiskLevel, string> = {
  critical: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300',
  high:     'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300',
  medium:   'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-300',
  low:      'bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300',
};

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded border ${styles[level]}`}>
      {level}
    </span>
  );
}
```

---

## Router

```typescript
// router.tsx
import { createBrowserRouter } from 'react-router-dom';
import Shell from './components/layout/Shell';
import Overview from './views/Overview';
import Hierarchy from './views/Hierarchy';
import ToolRegistry from './views/ToolRegistry';
import AgentMatrix from './views/AgentMatrix';
import ScopeEditor from './views/ScopeEditor';
import AgentACL from './views/AgentACL';
import Agencies from './views/Agencies';
import Discovery from './views/Discovery';
import AuditLog from './views/AuditLog';
import AgentDetail from './views/AgentDetail';
import Settings from './views/Settings';
import Login from './views/Login';

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true,             element: <Overview /> },
      { path: 'hierarchy',       element: <Hierarchy /> },
      { path: 'tools',           element: <ToolRegistry /> },
      { path: 'matrix',          element: <AgentMatrix /> },
      { path: 'scopes',          element: <ScopeEditor /> },
      { path: 'acl',             element: <AgentACL /> },
      { path: 'agencies',        element: <Agencies /> },
      { path: 'discovery',       element: <Discovery /> },
      { path: 'audit',           element: <AuditLog /> },
      { path: 'agents/:id',      element: <AgentDetail /> },
      { path: 'settings',        element: <Settings /> },
    ]
  }
]);
```

---

## Sidebar Navigation

```
Overview          /
Hierarchy         /hierarchy
Agencies          /agencies
─────────────────
Tools             /tools
Agent × Tool      /matrix
Scope editor      /scopes
Agent ACL         /acl
─────────────────
Discovery         /discovery
Audit log         /audit
─────────────────
Settings          /settings
```

---

## Environment Variables

```bash
VITE_API_BASE_URL=http://localhost:9443
VITE_APP_TITLE="Agency Control Center"
VITE_ENABLE_DARK_MODE=true
```
