import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function initDatabase(path: string): Database.Database {
  db = new Database(path);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    -- Spawned agents table (subprocess-based, existing behaviour)
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      workspace TEXT,
      model TEXT,
      config TEXT,
      pid INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      stopped_at INTEGER,
      error TEXT
    );

    -- Self-registered agents (agents that connect TO Dirigent)
    CREATE TABLE IF NOT EXISTS connected_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      version TEXT,
      capabilities TEXT,
      status TEXT NOT NULL DEFAULT 'online',
      connected_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      metadata TEXT
    );

    -- Agent logs table
    CREATE TABLE IF NOT EXISTS agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      metadata TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- Tasks table
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- Audit log table
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- Sessions table (for WebSocket connections)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      connected_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_activity INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata TEXT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_agent_logs_agent_id ON agent_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_logs_timestamp ON agent_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_connected_agents_status ON connected_agents(status);
    CREATE INDEX IF NOT EXISTS idx_connected_agents_last_seen ON connected_agents(last_seen);
  `);

  return db;
}

export function getDatabase(): Database.Database | null {
  return db;
}

// Helper functions
export function insertAgent(agent: {
  id: string;
  name: string;
  template: string;
  workspace?: string;
  model?: string;
  config?: object;
}) {
  const stmt = db!.prepare(`
    INSERT INTO agents (id, name, template, workspace, model, config)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    agent.id,
    agent.name,
    agent.template,
    agent.workspace || null,
    agent.model || null,
    agent.config ? JSON.stringify(agent.config) : null
  );
}

export function updateAgent(id: string, updates: Record<string, any>) {
  const keys = Object.keys(updates);
  const values = keys.map((k) => (typeof updates[k] === 'object' ? JSON.stringify(updates[k]) : updates[k]));

  const stmt = db!.prepare(`
    UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(', ')}
    WHERE id = ?
  `);

  stmt.run(...values, id);
}

export function getAgent(id: string) {
  const stmt = db!.prepare('SELECT * FROM agents WHERE id = ?');
  const row = stmt.get(id) as any;
  if (row?.config) row.config = JSON.parse(row.config);
  return row;
}

export function getAgents(includesStopped = false) {
  const stmt = db!.prepare(
    includesStopped
      ? 'SELECT * FROM agents ORDER BY created_at DESC'
      : "SELECT * FROM agents WHERE status != 'stopped' ORDER BY created_at DESC"
  );
  return stmt.all().map((row: any) => {
    if (row.config) row.config = JSON.parse(row.config);
    return row;
  });
}

export function insertLog(log: {
  agentId: string;
  level: string;
  message: string;
  metadata?: object;
}) {
  const stmt = db!.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, metadata)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(log.agentId, log.level, log.message, log.metadata ? JSON.stringify(log.metadata) : null);
}

export function getLogs(agentId: string, limit = 100) {
  const stmt = db!.prepare(`
    SELECT * FROM agent_logs
    WHERE agent_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  return stmt.all(agentId, limit).reverse().map((row: any) => {
    if (row.metadata) row.metadata = JSON.parse(row.metadata);
    return row;
  });
}

export function audit(action: string, actor: string | null, targetType: string | null, targetId: string | null, details?: object) {
  const stmt = db!.prepare(`
    INSERT INTO audit_log (action, actor, target_type, target_id, details)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(action, actor, targetType, targetId, details ? JSON.stringify(details) : null);
}

// ── Connected Agents (self-registered) ──────────────────────────────────────

export interface ConnectedAgentRow {
  id: string;
  name: string;
  type: string;
  version: string | null;
  capabilities: string[] | null;
  status: 'online' | 'idle' | 'offline';
  connected_at: number;
  last_seen: number;
  metadata: object | null;
}

export function upsertConnectedAgent(agent: {
  id: string;
  name: string;
  type: string;
  version?: string;
  capabilities?: string[];
  metadata?: object;
}): void {
  const now = Date.now();
  db!.prepare(`
    INSERT INTO connected_agents (id, name, type, version, capabilities, status, connected_at, last_seen, metadata)
    VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      version = excluded.version,
      capabilities = excluded.capabilities,
      status = 'online',
      connected_at = excluded.connected_at,
      last_seen = excluded.last_seen,
      metadata = excluded.metadata
  `).run(
    agent.id,
    agent.name,
    agent.type,
    agent.version ?? null,
    agent.capabilities ? JSON.stringify(agent.capabilities) : null,
    now,
    now,
    agent.metadata ? JSON.stringify(agent.metadata) : null,
  );
}

export function updateConnectedAgentHeartbeat(id: string, status: 'online' | 'idle' = 'online'): void {
  db!.prepare(`
    UPDATE connected_agents SET last_seen = ?, status = ? WHERE id = ?
  `).run(Date.now(), status, id);
}

export function updateConnectedAgentStatus(id: string, status: 'online' | 'idle' | 'offline'): void {
  db!.prepare(`
    UPDATE connected_agents SET status = ? WHERE id = ?
  `).run(status, id);
}

export function markStaleAgentsOffline(lastSeenBefore: number): string[] {
  const stale = db!.prepare(`
    SELECT id FROM connected_agents WHERE status != 'offline' AND last_seen < ?
  `).all(lastSeenBefore) as { id: string }[];

  if (stale.length > 0) {
    db!.prepare(`
      UPDATE connected_agents SET status = 'offline' WHERE status != 'offline' AND last_seen < ?
    `).run(lastSeenBefore);
  }

  return stale.map((r) => r.id);
}

export function getConnectedAgents(includeOffline = true): ConnectedAgentRow[] {
  const rows = (includeOffline
    ? db!.prepare('SELECT * FROM connected_agents ORDER BY connected_at DESC').all()
    : db!.prepare("SELECT * FROM connected_agents WHERE status != 'offline' ORDER BY connected_at DESC").all()
  ) as any[];

  return rows.map((r) => ({
    ...r,
    capabilities: r.capabilities ? JSON.parse(r.capabilities) : null,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  }));
}

export function getConnectedAgent(id: string): ConnectedAgentRow | null {
  const row = db!.prepare('SELECT * FROM connected_agents WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    ...row,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export function getConnectedAgentStats(): { total: number; online: number; idle: number; offline: number } {
  const row = db!.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
      SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END) as idle,
      SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline
    FROM connected_agents
  `).get() as any;
  return {
    total: row.total ?? 0,
    online: row.online ?? 0,
    idle: row.idle ?? 0,
    offline: row.offline ?? 0,
  };
}
