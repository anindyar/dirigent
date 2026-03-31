# ACC Deployment Guide

## Overview

This document covers three deployment scenarios:
1. **Local dev** — single machine, Docker Compose
2. **Internal enterprise** — on-prem server, Docker Compose (production hardened)
3. **Multi-site / K8s** — Helm chart for Kubernetes

---

## Prerequisites

```
Docker 24+
Docker Compose 2.20+
Python 3.11+ (for OpenClaw-ACC agents)
Node.js 20+ (for dashboard build)
openssl (for certificate generation)
```

---

## Step 0: Generate Certificates

The ACC uses a private CA to issue certificates. Run this once per deployment. Store CA private key securely (not on the ACC server in production — use a vault).

```bash
#!/bin/bash
# generate_certs.sh
# Run on a secure machine. Keep ca-key.pem offline after initial setup.

set -e
CERT_DIR="./certs"
mkdir -p "$CERT_DIR"

echo "── Generating ACC Certificate Authority ──"
openssl genrsa -out "$CERT_DIR/ca-key.pem" 4096
openssl req -new -x509 -days 3650 -key "$CERT_DIR/ca-key.pem" \
  -out "$CERT_DIR/ca.crt" \
  -subj "/CN=ACC-CA/O=TechImbue/C=AE"

echo "── Generating ACC Server Certificate ──"
openssl genrsa -out "$CERT_DIR/acc-server-key.pem" 2048
openssl req -new -key "$CERT_DIR/acc-server-key.pem" \
  -out "$CERT_DIR/acc-server.csr" \
  -subj "/CN=acc.techimbue.internal/O=TechImbue/C=AE"
openssl x509 -req -days 825 -in "$CERT_DIR/acc-server.csr" \
  -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca-key.pem" -CAcreateserial \
  -out "$CERT_DIR/acc-server.crt"

echo "── Generating ACC RSA Signing Key (for manifests) ──"
openssl genrsa -out "$CERT_DIR/acc-signing-key.pem" 2048
openssl rsa -in "$CERT_DIR/acc-signing-key.pem" -pubout \
  -out "$CERT_DIR/acc-signing-public.pem"

echo "── Done. Distribute to agents: ──"
echo "  ca.crt              → all agents (verify ACC server)"
echo "  acc-signing-public.pem → all agents (verify manifests)"
echo "── Keep private: ──"
echo "  ca-key.pem          → OFFLINE / vault"
echo "  acc-signing-key.pem → ACC server only"
```

### Per-Agent Certificate

Run this for each agent. The `AGENT_ID` must match the agent's registered `agent_id`.

```bash
#!/bin/bash
# issue_agent_cert.sh <AGENT_ID>
AGENT_ID=$1
CERT_DIR="./certs/agents"
mkdir -p "$CERT_DIR"

openssl genrsa -out "$CERT_DIR/$AGENT_ID-key.pem" 2048
openssl req -new -key "$CERT_DIR/$AGENT_ID-key.pem" \
  -out "$CERT_DIR/$AGENT_ID.csr" \
  -subj "/CN=$AGENT_ID/O=TechImbue/C=AE"
openssl x509 -req -days 365 -in "$CERT_DIR/$AGENT_ID.csr" \
  -CA "./certs/ca.crt" -CAkey "./certs/ca-key.pem" -CAcreateserial \
  -out "$CERT_DIR/$AGENT_ID.crt"

echo "Agent cert issued for $AGENT_ID"
echo "  cert: $CERT_DIR/$AGENT_ID.crt"
echo "  key:  $CERT_DIR/$AGENT_ID-key.pem"
```

---

## Scenario 1: Local Dev (Docker Compose)

### `docker/docker-compose.yml`

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: acc_db
      POSTGRES_USER: acc
      POSTGRES_PASSWORD: acc_dev_password
    volumes:
      - pg_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U acc -d acc_db"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  acc-server:
    build:
      context: ../server
      dockerfile: Dockerfile
    ports:
      - "9443:9443"
    environment:
      DATABASE_URL: postgresql+asyncpg://acc:acc_dev_password@postgres:5432/acc_db
      REDIS_URL: redis://redis:6379/0
      ACC_SECRET_KEY: dev-secret-key-change-in-production
      ACC_PRIVATE_KEY_PATH: /certs/acc-signing-key.pem
      ACC_PUBLIC_KEY_PATH: /certs/acc-signing-public.pem
      HOST: 0.0.0.0
      PORT: 9443
      CORS_ORIGINS: '["http://localhost:5173"]'
      ENABLE_MDNS_DISCOVERY: "true"
    volumes:
      - ./certs:/certs:ro
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  dashboard:
    build:
      context: ../dashboard
      dockerfile: Dockerfile
    ports:
      - "5173:80"
    environment:
      VITE_API_BASE_URL: http://localhost:9443
    depends_on:
      - acc-server

volumes:
  pg_data:
```

### `server/Dockerfile`

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN alembic upgrade head 2>/dev/null || true

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9443", \
     "--workers", "1", "--log-level", "info"]
```

### `dashboard/Dockerfile`

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json .
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### `dashboard/nginx.conf`

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API to ACC server
    location /api/ {
        proxy_pass http://acc-server:9443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # SSE — disable buffering
    location /api/v1/events/ {
        proxy_pass http://acc-server:9443;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
```

### Start local dev

```bash
cd docker
docker compose up -d
# Dashboard: http://localhost:5173
# ACC API:   http://localhost:9443/docs
```

---

## Scenario 2: Production (On-Prem, Hardened)

### `docker/docker-compose.prod.yml`

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:15-alpine
    restart: always
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./postgres-init:/docker-entrypoint-initdb.d:ro
    networks:
      - internal
    # NOT exposed externally in production

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
    volumes:
      - redis_data:/data
    networks:
      - internal

  acc-server:
    image: techimbue/acc-server:${ACC_VERSION}
    restart: always
    environment:
      DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0
      ACC_SECRET_KEY: ${ACC_SECRET_KEY}
      ACC_PRIVATE_KEY_PATH: /run/secrets/acc_signing_key
      ACC_CA_CERT_PATH: /run/secrets/ca_cert
      HOST: 0.0.0.0
      PORT: 9443
      CORS_ORIGINS: '["https://acc.${DOMAIN}"]'
      WORKERS: 4
    secrets:
      - acc_signing_key
      - ca_cert
    networks:
      - internal
      - external   # Only acc-server touches the external network
    ports:
      - "9443:9443"
    depends_on:
      - postgres
      - redis
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9443/health"]
      interval: 30s
      retries: 3

  dashboard:
    image: techimbue/acc-dashboard:${ACC_VERSION}
    restart: always
    networks:
      - external
    ports:
      - "443:443"
    volumes:
      - ./certs/acc-server.crt:/etc/nginx/ssl/server.crt:ro
      - ./certs/acc-server-key.pem:/etc/nginx/ssl/server.key:ro
      - ./nginx.prod.conf:/etc/nginx/conf.d/default.conf:ro

secrets:
  acc_signing_key:
    file: ./certs/acc-signing-key.pem
  ca_cert:
    file: ./certs/ca.crt

networks:
  internal:
    driver: bridge
    internal: true   # No external access
  external:
    driver: bridge

volumes:
  pg_data:
  redis_data:
```

### `.env.prod`

```bash
# Never commit this file
DOMAIN=techimbue.internal
ACC_VERSION=1.0.0
POSTGRES_DB=acc_db
POSTGRES_USER=acc_prod
POSTGRES_PASSWORD=<generate: openssl rand -hex 32>
REDIS_PASSWORD=<generate: openssl rand -hex 32>
ACC_SECRET_KEY=<generate: openssl rand -hex 64>
```

### Deploy

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

---

## Scenario 3: Kubernetes (Helm)

### Chart structure

```
docker/helm/acc/
├── Chart.yaml
├── values.yaml
├── templates/
│   ├── namespace.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   ├── deployment-server.yaml
│   ├── deployment-dashboard.yaml
│   ├── service-server.yaml
│   ├── service-dashboard.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   └── pvc.yaml
```

### `values.yaml`

```yaml
namespace: acc-system

server:
  image: techimbue/acc-server
  tag: "1.0.0"
  replicas: 2
  resources:
    requests: { cpu: "250m", memory: "512Mi" }
    limits:   { cpu: "1000m", memory: "1Gi" }
  env:
    HOST: "0.0.0.0"
    PORT: "9443"
    WORKERS: "4"
    MANIFEST_TTL_SECONDS: "3600"

dashboard:
  image: techimbue/acc-dashboard
  tag: "1.0.0"
  replicas: 2
  resources:
    requests: { cpu: "100m", memory: "128Mi" }
    limits:   { cpu: "500m", memory: "256Mi" }

postgres:
  enabled: true              # false = use external managed postgres
  storageSize: 20Gi
  storageClass: standard

redis:
  enabled: true
  storageSize: 2Gi

ingress:
  enabled: true
  className: nginx
  host: acc.techimbue.internal
  tls: true
  certSecret: acc-tls-secret

certManager:
  enabled: false             # true = use cert-manager for TLS
  issuer: letsencrypt-prod

hpa:
  enabled: true
  server:
    minReplicas: 2
    maxReplicas: 8
    cpuTarget: 70
```

### Deploy with Helm

```bash
helm install acc docker/helm/acc \
  --namespace acc-system \
  --create-namespace \
  --set server.env.ACC_SECRET_KEY=$(openssl rand -hex 64) \
  --set-file certSecrets.signingKey=./certs/acc-signing-key.pem \
  --set-file certSecrets.caCert=./certs/ca.crt

helm upgrade acc docker/helm/acc --namespace acc-system
```

---

## Database Migrations

```bash
# Run migrations (handled by server on startup in dev)
# In production, run as a pre-deploy job:
docker run --rm \
  -e DATABASE_URL="postgresql+asyncpg://..." \
  techimbue/acc-server:1.0.0 \
  alembic upgrade head

# Create a new migration
cd server
alembic revision --autogenerate -m "add_tool_tags"
alembic upgrade head
```

---

## Agent Deployment (OpenClaw-ACC)

### Per-agent setup script

```bash
#!/bin/bash
# setup_agent.sh <AGENT_ID> <ACC_SERVER_URL>
# Run on the machine that will host the agent

AGENT_ID=$1
ACC_SERVER=$2

# Install OpenClaw-ACC
pip install openclaw-acc

# Create config directory
mkdir -p ~/.openclaw-acc

# Copy certs (distributed by ACC admin)
cp ./certs/ca.crt ~/.openclaw-acc/
cp ./certs/acc-signing-public.pem ~/.openclaw-acc/
cp ./certs/agents/$AGENT_ID.crt ~/.openclaw-acc/agent.crt
cp ./certs/agents/$AGENT_ID-key.pem ~/.openclaw-acc/agent-key.pem

# Write config
cat > ~/.openclaw-acc/config.yaml << EOF
acc_server: "$ACC_SERVER"
agent_id: "$AGENT_ID"
api_key: "${AGENT_API_KEY}"   # Set as env var before running
cert_path: "$HOME/.openclaw-acc/agent.crt"
key_path: "$HOME/.openclaw-acc/agent-key.pem"
ca_cert_path: "$HOME/.openclaw-acc/ca.crt"
acc_public_key_path: "$HOME/.openclaw-acc/acc-signing-public.pem"
heartbeat_interval: 10
mdns_announce: true
log_tool_calls: true
EOF

echo "Agent $AGENT_ID configured. Start with: openclaw"
```

### Systemd service (production agents)

```ini
# /etc/systemd/system/openclaw-acc.service
[Unit]
Description=OpenClaw-ACC Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
Group=openclaw
ExecStart=/usr/local/bin/openclaw
Restart=on-failure
RestartSec=10
Environment=ACC_CONFIG_PATH=/etc/openclaw-acc/config.yaml
Environment=AGENT_API_KEY=<key>

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/log/openclaw

StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-acc

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable openclaw-acc
systemctl start openclaw-acc
journalctl -u openclaw-acc -f
```

---

## Monitoring & Observability

### Health endpoints

```
GET /health              → { "ok": true }
GET /health/db           → postgres connectivity
GET /health/redis        → redis connectivity
GET /health/agents       → connected agent count
GET /metrics             → Prometheus metrics (if enabled)
```

### Key metrics to track

| Metric | Alert threshold |
|--------|----------------|
| Connected agents / registered agents | < 80% for > 5 min |
| Heartbeat timeout rate | > 10% |
| Tool call block rate | > 5% sustained |
| Manifest issuance failures | any |
| WS reconnect rate | > 2/hour/agent |
| DB query latency (p95) | > 200ms |
| Redis memory usage | > 80% |

### Log aggregation

ACC Server logs in JSON format. Ship to Elastic (given your existing ECK stack on OpenShift):

```yaml
# Filebeat config for ACC logs
filebeat.inputs:
  - type: container
    paths:
      - /var/lib/docker/containers/**/acc-server*.log
    processors:
      - decode_json_fields:
          fields: ["message"]
          target: ""
output.elasticsearch:
  hosts: ["eck-prod.openshift.local:9200"]
  index: "acc-logs-%{+yyyy.MM.dd}"
```

---

## Backup Strategy

```bash
# Database backup (run daily via cron)
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups/acc"
mkdir -p "$BACKUP_DIR"

docker exec acc_postgres_1 pg_dump -U acc acc_db \
  | gzip > "$BACKUP_DIR/acc_db_$DATE.sql.gz"

# Keep 30 days
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +30 -delete

# Sync to S3 / object store
# aws s3 sync "$BACKUP_DIR" s3://techimbue-backups/acc/
```

---

## Security Hardening Checklist

- [ ] CA private key stored offline or in HashiCorp Vault / Azure Key Vault
- [ ] Agent API keys are minimum 32 bytes, stored hashed in DB
- [ ] mTLS enforced — plaintext WS connections rejected
- [ ] Manifest signatures verified on every agent boot and heartbeat
- [ ] PostgreSQL not exposed outside `internal` Docker network
- [ ] Redis not exposed outside `internal` Docker network
- [ ] Audit log table is append-only (revoke UPDATE/DELETE from app user)
- [ ] Dashboard behind HTTPS only — no HTTP in production
- [ ] JWT expiry ≤ 8 hours, refresh token rotation enabled
- [ ] CORS restricted to dashboard origin only
- [ ] Rate limiting on REST API (100 req/min per user, 1000 req/min per agent)
- [ ] Agent certificates renewed before expiry (365 day certs, renew at 300 days)
- [ ] Kill switch tested on each new agent after onboarding

---

## Enterprise Onboarding Flow (New Client)

```
1. Admin generates client-specific CA and signing key pair
2. Admin runs setup_agent.sh for each agent machine
3. Admin issues agent certs for each registered agent
4. Admin distributes: ca.crt, acc-signing-public.pem, agent cert/key to each machine
5. Admin registers agents via dashboard (or POST /api/v1/agents)
6. Admin assigns roles, tiers, parent agents
7. Admin creates agencies and adds agents
8. Admin configures tool grants via Agent × Tool matrix
9. Admin sets scope restrictions in Scope Editor
10. Admin sets agent ACL
11. Admin starts agents — they auto-connect, receive manifests, go live
12. Admin verifies: all agents show "active" in Overview
13. Admin runs: POST /discovery/scan to confirm no unregistered agents
```

Total onboarding time for a 6-agent network: approximately 30–45 minutes.
