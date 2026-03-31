# Dirigent Build Plan

**Project:** Dirigent — Enterprise Agent Fleet Management Platform  
**Codename:** ACC (Agency Control Center)  
**Author:** Buddy + Anindya Roy  
**Date:** March 31, 2026  
**Status:** Planning

---

## Executive Summary

Dirigent is an enterprise-grade control plane for managing autonomous AI agent networks. It solves the critical gap in the market: **governance and access control for AI agent fleets**.

While tools like LangChain, CrewAI, and AutoGen help *build* agents, Dirigent helps enterprises *govern* them — controlling which agents can use which tools, with what scopes, and maintaining full audit trails.

**Core Value Proposition:**
> "Tools are never self-declared by agents. They are granted by Dirigent."

---

## Architecture Review

### ✅ What's Solid

1. **Three-Layer Permission Model** — Agent→Agent, Agent→Tool, Tool→Scope is well-designed and mirrors enterprise IAM patterns (AWS IAM, K8s RBAC)

2. **Signed Manifests** — RSA-256 signed tool grants prevent tampering; agents verify before loading

3. **Live Revocation** — Relay interceptor checks every call against live manifest; no restart needed for policy changes

4. **mTLS + Token Auth** — Dual-factor authentication for agent connections

5. **Full Audit Trail** — Append-only audit log captures every tool call, block, and policy change

6. **WebSocket Control Channel** — Real-time push for manifest updates, pause, kill signals

### ⚠️ Concerns / Refinements Needed

1. **OpenClaw vs Clawdbot** — The spec references "OpenClaw" but we use Clawdbot. Need to decide:
   - Option A: Fork Clawdbot (makes sense for us)
   - Option B: Build ACC as a Clawdbot *plugin* (less invasive, faster to ship)
   - **Recommendation:** Start with Option B (plugin), graduate to fork later

2. **Scope Validation Complexity** — The relay.py hardcodes tool-specific validators (GPIO pins, AWS regions, etc.). This doesn't scale.
   - **Recommendation:** Use a declarative scope schema (JSON Schema or CEL expressions) instead of hardcoded validators

3. **Discovery Service** — mDNS + port scanning is good for internal networks but won't work for cloud agents
   - **Recommendation:** Add API-based registration as primary method; discovery as secondary

4. **Agent Model Assumptions** — Spec assumes all agents run OpenClaw-ACC. Real enterprises have diverse agent runtimes.
   - **Recommendation:** Define a lightweight "ACC Agent SDK" that any runtime can implement

5. **Dashboard Scope** — The frontend spec is very detailed. For MVP, we should simplify.
   - **Recommendation:** Phase the dashboard features

---

## Naming Decision

The folder is "dirigent" but the specs say "ACC". Let's settle on:

- **Product Name:** Dirigent (conducting an orchestra of agents)
- **Internal Codename:** ACC (Agency Control Center)
- **API Prefix:** `/api/v1/` (no change)

---

## Competitive Landscape

| Solution | Focus | Governance | Tool Control | Enterprise Ready |
|----------|-------|------------|--------------|------------------|
| LangChain/LangSmith | Agent building + tracing | ❌ | ❌ | Partial |
| CrewAI | Multi-agent orchestration | ❌ | ❌ | ❌ |
| AutoGen (Microsoft) | Agent conversations | ❌ | ❌ | ❌ |
| Composio | Tool integrations | ❌ | Partial | Partial |
| AWS Bedrock Agents | Cloud agents | Partial | IAM-based | ✅ |
| **Dirigent** | Fleet governance | ✅ | ✅ | ✅ |

**Market Gap:** No solution focuses specifically on **governing agent fleets at scale** with tool-level access control, scope constraints, and audit trails. Dirigent fills this gap.

---

## Build Phases

### Phase 1: Foundation (Weeks 1-3)
**Goal:** Core server + minimal dashboard + single-agent connectivity

| Component | Tasks | Days |
|-----------|-------|------|
| ACC Server | FastAPI skeleton, DB models, Alembic migrations | 3 |
| | Agent CRUD endpoints | 1 |
| | Tool CRUD endpoints | 1 |
| | Permission matrix endpoints (agent_tool_grants) | 2 |
| | Manifest generation + RSA signing | 2 |
| | WebSocket manager (connect, heartbeat, kill) | 3 |
| | JWT auth for dashboard | 1 |
| Dashboard | Vite + React + Tailwind scaffold | 1 |
| | Login page | 0.5 |
| | Overview page (agent list, status) | 1.5 |
| Docker | Compose for local dev | 0.5 |
| Certs | Certificate generation scripts | 0.5 |

**Deliverable:** Server that can register agents, issue manifests, and show them in dashboard

---

### Phase 2: Clawdbot Integration (Weeks 4-5)
**Goal:** Clawdbot plugin that connects to Dirigent and enforces manifests

| Component | Tasks | Days |
|-----------|-------|------|
| Clawdbot Plugin | ACC kernel as Clawdbot plugin (not fork) | 3 |
| | WebSocket client (connect, register, heartbeat) | 2 |
| | Manifest receiver + signature verification | 1 |
| | Tool relay interceptor | 2 |
| | Config schema (acc_config.yaml equivalent) | 0.5 |
| Integration Test | End-to-end: server → Clawdbot → tool call → audit | 1.5 |

**Deliverable:** Clawdbot that only uses tools granted by Dirigent server

---

### Phase 3: Dashboard MVP (Weeks 6-7)
**Goal:** Functional admin UI for day-to-day operations

| Component | Tasks | Days |
|-----------|-------|------|
| Dashboard | Agent × Tool matrix (full CRUD) | 2 |
| | Scope editor (basic key-value) | 1.5 |
| | Audit log (paginated, filtered) | 1.5 |
| | Agent detail page | 1 |
| | SSE live events | 1 |
| | Kill/Pause buttons | 0.5 |
| | Hierarchy view (simple tree) | 1.5 |

**Deliverable:** Admin can manage permissions and see live activity

---

### Phase 4: Production Hardening (Weeks 8-9)
**Goal:** Security, reliability, observability

| Component | Tasks | Days |
|-----------|-------|------|
| Security | mTLS for agent connections | 2 |
| | Rate limiting | 0.5 |
| | Input validation hardening | 1 |
| | Audit log immutability | 0.5 |
| Reliability | Reconnection logic (agent) | 1 |
| | Health endpoints | 0.5 |
| | Graceful shutdown | 0.5 |
| Observability | Prometheus metrics | 1 |
| | Structured logging | 0.5 |
| Deployment | Docker Compose production | 1 |
| | Helm chart (basic) | 2 |

**Deliverable:** Production-ready deployment

---

### Phase 5: Advanced Features (Weeks 10-12)
**Goal:** Enterprise differentiation

| Component | Tasks | Days |
|-----------|-------|------|
| Agent ACL | Agent-to-agent permissions | 2 |
| Agencies | Agency/team management | 2 |
| Discovery | Network scan + mDNS | 2 |
| | Auto-registration flow | 1 |
| Scopes v2 | Declarative scope schemas (JSON Schema) | 3 |
| | Scope validation engine | 2 |
| Dashboard | Agency management UI | 1 |
| | Discovery UI | 1 |

**Deliverable:** Full feature parity with spec

---

## Tech Stack (Confirmed)

| Component | Technology | Notes |
|-----------|------------|-------|
| Server | Python 3.11 + FastAPI | Matches Clawdbot ecosystem |
| Database | PostgreSQL 15 | JSONB for flexible scopes |
| Cache | Redis 7 | Presence, pub/sub |
| Frontend | React 18 + Vite + TypeScript | Modern, fast |
| UI | shadcn/ui + Tailwind | Consistent, accessible |
| State | Zustand + React Query | Lightweight |
| Agent Runtime | Clawdbot (plugin-based) | Phase 1: plugin, Phase 2+: optional fork |
| Auth | JWT (dashboard) + mTLS (agents) | Dual model |
| Containers | Docker + Compose / Helm | Flexible deploy |

---

## Resource Estimate

**Solo developer (Buddy assisting):**
- Phase 1-3 (MVP): 7 weeks
- Phase 4-5 (Production): 5 weeks
- **Total:** ~12 weeks to full feature parity

**Two developers:**
- Phase 1-3: 4 weeks
- Phase 4-5: 3 weeks
- **Total:** ~7 weeks

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Clawdbot internals change | Plugin breaks | Keep plugin minimal; contribute upstream if needed |
| Scope validation complexity | Hardcoded validators don't scale | Use declarative schemas from Phase 5 |
| WebSocket at scale | Memory/connection limits | Connection pooling, horizontal scale |
| mTLS complexity | Cert management overhead | Provide CLI tooling for cert lifecycle |
| Scope creep | Never ships | Strict phase gates; MVP first |

---

## Open Questions

1. **Pricing Model?** — SaaS vs self-hosted vs hybrid?
2. **Multi-tenancy?** — Single-tenant first, multi-tenant later?
3. **Cloud Agents?** — How do cloud-hosted agents (Lambda, Cloud Run) connect?
4. **SDK Languages?** — Python SDK first, then Node, Go?
5. **Name Final?** — "Dirigent" vs "ACC" vs something else?

---

## Next Steps

1. ✅ Review BUILD_PLAN.md (you're reading it)
2. ✅ Review BRD.md (attached)
3. 🔲 Anindya approves or requests changes
4. 🔲 Scaffold project structure
5. 🔲 Start Phase 1

---

## Appendix: File Structure (Proposed)

```
dirigent/
├── README.md
├── BUILD_PLAN.md          ← this file
├── BRD.md                 ← business requirements
├── ARCHITECTURE.md        ← (merge existing specs)
│
├── server/                ← ACC Server (FastAPI)
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── routers/
│   │   ├── models/
│   │   ├── services/
│   │   ├── ws/
│   │   └── tests/
│   ├── alembic/
│   ├── requirements.txt
│   └── Dockerfile
│
├── dashboard/             ← React frontend
│   ├── src/
│   ├── public/
│   ├── package.json
│   ├── vite.config.ts
│   └── Dockerfile
│
├── clawdbot-plugin/       ← Clawdbot ACC plugin
│   ├── src/
│   │   ├── index.ts
│   │   ├── kernel.ts
│   │   ├── relay.ts
│   │   └── config.ts
│   ├── package.json
│   └── README.md
│
├── sdk/                   ← Agent SDKs (future)
│   ├── python/
│   └── node/
│
├── docker/
│   ├── docker-compose.yml
│   ├── docker-compose.prod.yml
│   └── helm/
│
├── scripts/
│   ├── generate_certs.sh
│   └── issue_agent_cert.sh
│
└── docs/                  ← (move existing specs here)
    ├── ACC_SERVER.md
    ├── DASHBOARD.md
    ├── DEPLOYMENT.md
    └── OPENCLAW_FORK.md
```
