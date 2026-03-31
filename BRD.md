# Dirigent — Business Requirements Document (BRD)

**Document Version:** 1.0  
**Author:** Buddy + Anindya Roy  
**Date:** March 31, 2026  
**Classification:** Internal

---

## 1. Executive Summary

### 1.1 Problem Statement

Enterprises are rapidly deploying autonomous AI agents across their operations — coding assistants, data analysts, customer service bots, infrastructure managers. However, there is **no unified control plane** for:

- **Knowing** what agents exist in the organization
- **Controlling** which tools each agent can access
- **Constraining** the scope of those tools (e.g., "AWS access, but only us-east-1")
- **Auditing** every action agents take
- **Revoking** access in real-time without restarting agents

The result: **Shadow AI agents** proliferating with uncontrolled access, creating security, compliance, and operational risks.

### 1.2 Solution

**Dirigent** is an enterprise control plane for AI agent fleets. It provides:

| Capability | Description |
|------------|-------------|
| **Agent Registry** | Discover, register, and inventory all agents |
| **Tool Governance** | Agents only get tools explicitly granted by admins |
| **Scope Constraints** | Fine-grained limits (regions, buckets, time windows) |
| **Real-time Control** | Pause, resume, kill any agent instantly |
| **Full Audit Trail** | Every tool call logged, searchable, exportable |
| **Hierarchy Management** | Organize agents into teams/agencies |

### 1.3 Target Users

1. **Platform Engineers** — Deploy and operate agent infrastructure
2. **Security/Compliance** — Ensure agents don't exceed authorized access
3. **AI/ML Engineers** — Build agents that integrate with Dirigent
4. **IT Operations** — Monitor and troubleshoot agent fleets

---

## 2. Business Objectives

### 2.1 Primary Objectives

| # | Objective | Success Metric |
|---|-----------|----------------|
| 1 | Reduce unauthorized agent tool access incidents | 90% reduction in shadow AI usage |
| 2 | Provide complete audit trail for compliance | 100% of agent actions logged |
| 3 | Enable real-time response to security events | Agent can be killed within 5 seconds |
| 4 | Simplify agent permission management | Permission change takes < 30 seconds |

### 2.2 Business Value

**Risk Reduction:**
- Prevents agents from accessing unauthorized data (PII, financial, classified)
- Provides audit trail for regulatory compliance (SOC 2, ISO 27001, GDPR)
- Enables incident response (kill switch, revocation)

**Operational Efficiency:**
- Single pane of glass for agent fleet management
- Reduces time to onboard new agents
- Standardizes agent deployment patterns

**Competitive Differentiation:**
- First-to-market enterprise agent governance platform
- Can be sold as standalone product or bundled with consulting services

---

## 3. Scope

### 3.1 In Scope (MVP)

| Feature | Priority | Phase |
|---------|----------|-------|
| Agent registration and discovery | P0 | 1 |
| Tool catalog management | P0 | 1 |
| Agent-to-tool permission matrix | P0 | 1 |
| Signed tool manifests | P0 | 2 |
| Tool relay enforcement | P0 | 2 |
| Real-time WebSocket control channel | P0 | 1 |
| Dashboard: Overview, Matrix, Audit | P0 | 3 |
| mTLS agent authentication | P1 | 4 |
| Kill/Pause/Resume commands | P1 | 3 |
| Basic scope constraints (key-value) | P1 | 3 |

### 3.2 In Scope (Post-MVP)

| Feature | Priority | Phase |
|---------|----------|-------|
| Agent-to-agent ACL | P2 | 5 |
| Agency/team management | P2 | 5 |
| Network discovery (mDNS, scan) | P2 | 5 |
| Declarative scope schemas | P2 | 5 |
| Multi-tenant support | P3 | Future |
| SaaS deployment option | P3 | Future |
| Additional SDKs (Go, Rust) | P3 | Future |

### 3.3 Out of Scope

- Agent development tools (use Clawdbot, LangChain, etc.)
- Model hosting/inference (use existing providers)
- Agent conversation/memory management
- Direct cloud provider integrations (agents handle this)

---

## 4. Functional Requirements

### 4.1 Agent Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-A01 | System shall allow manual agent registration via API/UI | P0 |
| FR-A02 | System shall accept agent self-registration via WebSocket | P0 |
| FR-A03 | System shall track agent status (active, busy, offline, paused) | P0 |
| FR-A04 | System shall store agent metadata (model, role, tier, capabilities) | P0 |
| FR-A05 | System shall support agent hierarchy (parent-child relationships) | P1 |
| FR-A06 | System shall allow agent deregistration | P0 |
| FR-A07 | System shall discover agents via mDNS and network scanning | P2 |

### 4.2 Tool Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-T01 | System shall maintain a tool catalog with metadata | P0 |
| FR-T02 | Tools shall have risk levels (critical, high, medium, low) | P0 |
| FR-T03 | Tools shall have global scope constraints | P0 |
| FR-T04 | Tools shall have defined operations (action list) | P0 |
| FR-T05 | System shall track tool usage statistics | P1 |

### 4.3 Permission Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-P01 | System shall support none/read/full access levels | P0 |
| FR-P02 | System shall allow per-agent scope overrides | P0 |
| FR-P03 | System shall allow per-agent operation restrictions | P1 |
| FR-P04 | System shall support permission expiry dates | P2 |
| FR-P05 | Permissions shall be applied without agent restart | P0 |

### 4.4 Manifest System

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-M01 | System shall generate tool manifests for each agent | P0 |
| FR-M02 | Manifests shall be RSA-256 signed | P0 |
| FR-M03 | Manifests shall have version numbers | P0 |
| FR-M04 | Manifests shall have expiry times | P1 |
| FR-M05 | System shall push manifest updates via WebSocket | P0 |
| FR-M06 | Agents shall verify manifest signatures | P0 |

### 4.5 Control Operations

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-C01 | System shall send kill signal to any connected agent | P0 |
| FR-C02 | System shall send pause/resume signals | P1 |
| FR-C03 | System shall receive heartbeats from connected agents | P0 |
| FR-C04 | System shall detect agent disconnection within 30 seconds | P0 |
| FR-C05 | System shall support bulk operations (pause all, refresh all manifests) | P2 |

### 4.6 Audit Logging

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-L01 | System shall log all tool calls with parameters | P0 |
| FR-L02 | System shall log all blocked tool calls with reason | P0 |
| FR-L03 | System shall log all permission changes | P0 |
| FR-L04 | System shall log all agent lifecycle events | P0 |
| FR-L05 | Audit log shall be immutable (append-only) | P1 |
| FR-L06 | Audit log shall be queryable by agent, tool, time, outcome | P0 |
| FR-L07 | Audit log shall be exportable to CSV | P1 |

### 4.7 Dashboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-D01 | Dashboard shall display real-time agent status | P0 |
| FR-D02 | Dashboard shall provide Agent × Tool permission matrix | P0 |
| FR-D03 | Dashboard shall show audit log with filters | P0 |
| FR-D04 | Dashboard shall allow editing permissions inline | P0 |
| FR-D05 | Dashboard shall show agent hierarchy as tree | P1 |
| FR-D06 | Dashboard shall support dark mode | P2 |

---

## 5. Non-Functional Requirements

### 5.1 Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-P01 | API response time (p95) | < 200ms |
| NFR-P02 | WebSocket message latency | < 100ms |
| NFR-P03 | Manifest generation time | < 500ms |
| NFR-P04 | Kill signal delivery | < 5 seconds |
| NFR-P05 | Concurrent agent connections | 1,000+ |
| NFR-P06 | Audit log ingestion rate | 10,000 events/minute |

### 5.2 Reliability

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-R01 | System availability | 99.9% |
| NFR-R02 | Agent reconnection after server restart | < 30 seconds |
| NFR-R03 | Data durability (audit log) | No data loss |
| NFR-R04 | Graceful degradation on DB failure | Queue writes, retry |

### 5.3 Security

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-S01 | All agent connections over TLS 1.3 | Required |
| NFR-S02 | mTLS for agent authentication | P1 feature |
| NFR-S03 | API keys stored hashed (bcrypt) | Required |
| NFR-S04 | Manifest signatures verified by agents | Required |
| NFR-S05 | No sensitive data in logs | Required |
| NFR-S06 | JWT expiry | ≤ 8 hours |
| NFR-S07 | Rate limiting | 100 req/min per user |

### 5.4 Scalability

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-SC01 | Horizontal scaling of API servers | Stateless design |
| NFR-SC02 | WebSocket connection distribution | Redis pub/sub |
| NFR-SC03 | Database partitioning | By timestamp for audit log |

### 5.5 Compliance

| ID | Requirement | Notes |
|----|-------------|-------|
| NFR-C01 | Audit log supports SOC 2 requirements | Immutable, complete |
| NFR-C02 | Supports ISO 27001 access logging | All actions logged |
| NFR-C03 | GDPR data subject access | Export agent data |

---

## 6. User Stories

### 6.1 Platform Engineer

> **As a** Platform Engineer  
> **I want to** register a new agent and grant it specific tool access  
> **So that** the agent can perform its designated tasks without unauthorized capabilities

**Acceptance Criteria:**
- Can register agent via API or dashboard
- Can grant tools with access levels
- Can set scope constraints
- Agent receives manifest within 10 seconds of grant

---

> **As a** Platform Engineer  
> **I want to** immediately revoke an agent's tool access  
> **So that** I can respond to security incidents without waiting for restarts

**Acceptance Criteria:**
- Can revoke tool in dashboard
- Agent receives updated manifest within 10 seconds
- Next tool call is blocked
- Event is logged in audit trail

---

### 6.2 Security Engineer

> **As a** Security Engineer  
> **I want to** view all tool calls made by agents in the last 24 hours  
> **So that** I can investigate suspicious activity

**Acceptance Criteria:**
- Audit log shows all calls with timestamps
- Can filter by agent, tool, outcome
- Can see parameters (sanitized)
- Can export to CSV

---

> **As a** Security Engineer  
> **I want to** kill a compromised agent immediately  
> **So that** I can stop ongoing malicious activity

**Acceptance Criteria:**
- Kill button in dashboard
- Agent terminates within 5 seconds
- Event logged with reason
- Agent status shows "killed"

---

### 6.3 Compliance Officer

> **As a** Compliance Officer  
> **I want to** prove that agents only access authorized tools  
> **So that** I can satisfy auditor requirements

**Acceptance Criteria:**
- Audit log shows granted permissions at time of call
- Blocked calls show reason
- Log is immutable (cannot be edited)
- Can export for audit period

---

### 6.4 AI Engineer

> **As an** AI Engineer  
> **I want to** build an agent that integrates with Dirigent  
> **So that** my agent follows enterprise governance policies

**Acceptance Criteria:**
- Clear documentation for integration
- SDK/plugin available for common runtimes
- Agent fails gracefully if Dirigent unreachable
- Development mode for local testing

---

## 7. Integration Requirements

### 7.1 Agent Runtimes

| Runtime | Integration Method | Priority |
|---------|-------------------|----------|
| Clawdbot | Native plugin | P0 |
| LangChain | Python SDK | P2 |
| Custom agents | REST + WebSocket API | P1 |

### 7.2 External Systems

| System | Integration | Priority |
|--------|-------------|----------|
| SSO (SAML/OIDC) | Dashboard auth | P2 |
| SIEM (Splunk, Elastic) | Log forwarding | P2 |
| Slack/Teams | Alert notifications | P3 |
| HashiCorp Vault | Cert/secret management | P2 |

---

## 8. Assumptions & Constraints

### 8.1 Assumptions

1. Agents will be modified to include Dirigent client (SDK/plugin)
2. Network connectivity exists between agents and Dirigent server
3. Admins have access to deploy certificates to agent machines
4. Initial deployment is single-tenant (one organization)

### 8.2 Constraints

1. Cannot modify third-party agent runtimes (only wrap/intercept)
2. Cannot guarantee enforcement for agents not running Dirigent client
3. WebSocket connections require persistent network paths

---

## 9. Risks & Dependencies

### 9.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Agent runtimes don't support interception | Medium | High | Design thin SDK; document integration patterns |
| Performance impact of relay validation | Low | Medium | Optimize hot paths; cache manifests |
| Certificate management complexity | Medium | Medium | Provide CLI tooling; document clearly |
| Scope creep delays MVP | High | High | Strict phase gates; defer nice-to-haves |

### 9.2 Dependencies

| Dependency | Owner | Notes |
|------------|-------|-------|
| Clawdbot plugin architecture | Clawdbot maintainers | May need upstream contribution |
| PostgreSQL 15 | Ops | Standard deployment |
| Redis 7 | Ops | Standard deployment |
| TLS certificates | Security team | Internal CA or Let's Encrypt |

---

## 10. Success Criteria

### 10.1 MVP Success (Phase 1-3)

- [ ] 3+ agents registered and actively reporting heartbeats
- [ ] Admin can grant/revoke tools from dashboard
- [ ] Tool calls are blocked when not in manifest
- [ ] Audit log captures all tool calls
- [ ] Kill signal terminates agent within 5 seconds

### 10.2 Production Success (Phase 4-5)

- [ ] 50+ agents managed by single Dirigent deployment
- [ ] mTLS enabled for all agent connections
- [ ] Zero untracked tool calls (100% audit coverage)
- [ ] < 1% permission-change-to-enforcement latency > 30 seconds
- [ ] Successfully passes SOC 2 relevant control testing

---

## 11. Glossary

| Term | Definition |
|------|------------|
| **Agent** | An autonomous AI system that can use tools to perform tasks |
| **Tool** | A capability (API, function, integration) that an agent can invoke |
| **Manifest** | Signed document listing tools an agent is allowed to use |
| **Scope** | Constraints on how a tool can be used (regions, buckets, time windows) |
| **Relay** | Interceptor layer that validates tool calls against manifest |
| **Agency** | A group of agents organized hierarchically for a purpose |
| **ACC** | Agency Control Center — internal codename for Dirigent |

---

## 12. Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Product Owner | Anindya Roy | | |
| Technical Lead | Buddy | ✅ | 2026-03-31 |
| Security Review | | | |

---

## Appendix A: Competitive Analysis Summary

| Competitor | What They Do | What They Don't Do |
|------------|--------------|-------------------|
| LangChain | Agent building, tracing | Tool governance, fleet control |
| CrewAI | Multi-agent orchestration | Permission management, audit |
| AutoGen | Agent conversations | Tool access control |
| Composio | Tool integrations | Enterprise governance |
| OpenAI Assistants | Hosted agents | Self-hosted, custom control |

**Dirigent's Differentiation:** Enterprise governance layer that works with ANY agent runtime, providing tool access control, scope constraints, and audit trails that other platforms lack.

---

## Appendix B: Market Size Estimate

**Total Addressable Market (TAM):**
- Enterprises deploying AI agents: ~50,000 globally (2026)
- Average spend on AI infrastructure: $500K/year
- Governance/security portion: ~10%
- **TAM:** $2.5B

**Serviceable Addressable Market (SAM):**
- Enterprises with 10+ agents requiring governance: ~5,000
- Average deal size: $50K/year
- **SAM:** $250M

**Serviceable Obtainable Market (SOM):**
- Year 1 target: 50 customers
- Average deal: $30K
- **SOM:** $1.5M ARR (Year 1)
