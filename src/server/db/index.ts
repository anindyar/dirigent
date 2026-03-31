import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function initDatabase(path: string): Database.Database {
  db = new Database(path);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    -- Agents table
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
