# Distributed Secure Group Chat — Phase 2

A distributed, high-availability group chat application with dynamic load balancing, end-to-end encryption, and shared persistent storage.

## Architecture

```
Official Load Generator / Browser
              |
              v
   SYS1  172.17.0.62:3000   ← Node.js Dynamic Load Balancer (HTTP)
              |
    +---------+---------+
    |         |         |
SYS2:3000  SYS3:3000  SYS4:3000   ← Node.js Backends (TLS remains supported)
    |         |         |
    +---------+---------+
              |
  PostgreSQL @ 172.17.0.63:5432  ← Shared DB (SYS2)
```

| System | IP             | Role                              | Port |
|--------|----------------|-----------------------------------|------|
| SYS1   | 172.17.0.62    | Node.js Dynamic Load Balancer     | 3000 |
| SYS2   | 172.17.0.63    | Node.js Backend + PostgreSQL DB   | 3000 / 5432 |
| SYS3   | 172.17.0.64    | Node.js Backend                   | 3000 |
| SYS4   | 172.17.0.65    | Node.js Backend                   | 3000 |

## Required API Routes (via Load Balancer)

| Method | Path       | Description                              |
|--------|------------|------------------------------------------|
| POST   | `/message` | Submit a chat message                    |
| GET    | `/feed`    | Retrieve all messages                    |
| GET    | `/lb/metrics` | LB performance metrics (JSON)         |
| GET    | `/lb/health`  | LB health status                      |

### POST /message

```bash
curl -X POST http://172.17.0.62:3000/message \
  -H "Content-Type: application/json" \
  -d '{"client-name": "alice", "msg": "Hello world!"}'
```

**Accepts** (all equivalent):
- `client-name` or `client_name` → sender name
- `msg` or `message` → message text
- `message_id` (optional UUID) → for idempotent retries

**Response:**
```json
{
  "ok": true,
  "message_id": "550e8400-e29b-41d4-a716-446655440000",
  "sender": "alice",
  "timestamp": "2024-09-14T12:00:00.000Z",
  "instance": "SYS2"
}
```

### GET /feed

```bash
curl http://172.17.0.62:3000/feed
```

**Response:**
```json
{
  "messages": [
    {
      "message_id": "550e8400-e29b-41d4-a716-446655440000",
      "sender": "alice",
      "message": "Hello world!",
      "origin_node": "SYS2",
      "timestamp": "2024-09-14T12:00:00.000Z"
    }
  ],
  "count": 1,
  "instance": "SYS2"
}
```

## Security Features

- **AES-256-GCM** encryption at rest with one shared key across all backends
- **ECDSA P-256** message signatures and server-side verification for the existing Socket.IO chat path
- **HTTPS/TLS support** remains available on each backend; deployment scripts keep the existing HTTP port/IP configuration unchanged
- **Message deduplication** via UUID `message_id` + `ON CONFLICT DO NOTHING`
- All credentials configurable via environment variables

## Load Balancer Algorithm

The LB selects backends using a **weighted performance score**:

```
score = 0.40×norm(queueLength)
      + 0.20×norm(cpu%)
      + 0.10×norm(memory%)
      + 0.15×norm(activeRequests)
      + 0.15×norm(avgResponseTime)
```

- `norm(x) = x / max(x across all healthy backends)`
- **Lower score = better backend**
- Configurable `OVERLOAD_THRESHOLD` (default 70/100) and `RECOVERY_THRESHOLD` (default 55/100)
- Passive failure detection: 3 consecutive errors → backend marked unhealthy
- Active health polling every 1.5s as fallback
- Heartbeat-based stale detection (3s timeout by default)
- Idempotent POST `/message` retry with stable `message_id`

---

## Deployment

### Step 1 — PostgreSQL on SYS2 (172.17.0.63)

```bash
# Install
sudo apt update && sudo apt install -y postgresql postgresql-contrib

# Start
sudo service postgresql start

# Create DB and user
sudo -u postgres psql <<EOF
CREATE DATABASE chat_db;
CREATE USER student WITH PASSWORD 'password123';
GRANT ALL PRIVILEGES ON DATABASE chat_db TO student;
\c chat_db
GRANT ALL ON SCHEMA public TO student;
GRANT ALL ON ALL TABLES IN SCHEMA public TO student;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO student;
EOF

# Allow remote connections
echo "listen_addresses = '*'" | sudo tee -a /etc/postgresql/*/main/postgresql.conf
echo "host all all 0.0.0.0/0 md5" | sudo tee -a /etc/postgresql/*/main/pg_hba.conf
sudo service postgresql restart

# (Optional) Apply schema manually
psql -U student -h localhost -d chat_db -f db/schema.sql
```

### Step 2 — SSL Certificates (all systems)

Generate once, copy to all systems:

```bash
openssl req -x509 -newkey rsa:4096 \
  -keyout key.pem -out cert.pem \
  -sha256 -days 365 -nodes \
  -subj "/CN=172.17.0.63"

# Copy to SYS3, SYS4, SYS1
scp key.pem cert.pem user@172.17.0.64:~/app/
scp key.pem cert.pem user@172.17.0.65:~/app/
scp key.pem cert.pem user@172.17.0.62:~/app/
```

### Step 3 — Node.js Backends (SYS2, SYS3, SYS4)

```bash
# Install dependencies (on each backend system)
cd /path/to/app
npm install

# SYS2 (172.17.0.63)
nohup env \
  INSTANCE_NAME=SYS2 \
  PORT=3000 \
  DB_HOST=172.17.0.63 \
  DB_PORT=5432 \
  DB_NAME=chat_db \
  DB_USER=student \
  DB_PASSWORD=password123 \
  LB_URL=http://172.17.0.62:3000 \
  HEARTBEAT_INTERVAL_MS=1000 \
  node server/index.js > sys2.log 2>&1 &

# SYS3 (172.17.0.64)
nohup env \
  INSTANCE_NAME=SYS3 \
  PORT=3000 \
  DB_HOST=172.17.0.63 \
  DB_PORT=5432 \
  DB_NAME=chat_db \
  DB_USER=student \
  DB_PASSWORD=password123 \
  LB_URL=http://172.17.0.62:3000 \
  HEARTBEAT_INTERVAL_MS=1000 \
  node server/index.js > sys3.log 2>&1 &

# SYS4 (172.17.0.65)
nohup env \
  INSTANCE_NAME=SYS4 \
  PORT=3000 \
  DB_HOST=172.17.0.63 \
  DB_PORT=5432 \
  DB_NAME=chat_db \
  DB_USER=student \
  DB_PASSWORD=password123 \
  LB_URL=http://172.17.0.62:3000 \
  HEARTBEAT_INTERVAL_MS=1000 \
  node server/index.js > sys4.log 2>&1 &
```

### Step 4 — Go Load Balancer (SYS1)

```bash
cd /path/to/app

# Build
go build -o loadbalancer main.go

# Run (HTTP, recommended — backends are HTTPS internally)
nohup ./loadbalancer \
  -port 3000 \
  -backends "https://172.17.0.63:3000,https://172.17.0.64:3000,https://172.17.0.65:3000" \
  > lb.log 2>&1 &

# Or with custom thresholds:
nohup env \
  OVERLOAD_THRESHOLD=65 \
  RECOVERY_THRESHOLD=50 \
  HEARTBEAT_TIMEOUT=3s \
  W_QUEUE=0.40 W_CPU=0.20 W_MEMORY=0.10 W_ACTIVE=0.15 W_RESPTIME=0.15 \
  ./loadbalancer -port 3000 \
  -backends "https://172.17.0.63:3000,https://172.17.0.64:3000,https://172.17.0.65:3000" \
  > lb.log 2>&1 &
```

---

## Verification

### Check LB health
```bash
curl http://172.17.0.62:3000/lb/health
```

### Check LB metrics (backends, scores, latency)
```bash
curl http://172.17.0.62:3000/lb/metrics | python3 -m json.tool
```

### Test POST /message
```bash
curl -X POST http://172.17.0.62:3000/message \
  -H "Content-Type: application/json" \
  -d '{"client-name":"testuser","msg":"hello!"}'
```

### Test GET /feed
```bash
curl http://172.17.0.62:3000/feed | python3 -m json.tool
```

### Test duplicate prevention
```bash
UUID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
curl -X POST http://172.17.0.62:3000/message \
  -H "Content-Type: application/json" \
  -d "{\"client-name\":\"alice\",\"msg\":\"test\",\"message_id\":\"$UUID\"}"

# Send same UUID again — should still return ok but DB has only 1 row
curl -X POST http://172.17.0.62:3000/message \
  -H "Content-Type: application/json" \
  -d "{\"client-name\":\"alice\",\"msg\":\"test\",\"message_id\":\"$UUID\"}"

# Verify only 1 entry in feed with this message_id
curl http://172.17.0.62:3000/feed | python3 -c "
import json,sys
data=json.load(sys.stdin)
count=sum(1 for m in data['messages'] if m.get('message_id')=='$UUID')
print('Duplicate count:', count)  # Should be 1
"
```

---

## Load Generator

```bash
# Basic test
node load_generator.js --url http://172.17.0.62:3000 --users 10 --duration 30

# Heavy test
node load_generator.js \
  --url http://172.17.0.62:3000 \
  --users 50 \
  --duration 120 \
  --minDelay 50 \
  --maxDelay 500 \
  --minLen 20 \
  --maxLen 300 \
  --feedRatio 0.3 \
  --output results.json
```

---

## Environment Variables Reference

### Backend (server/index.js)

| Variable              | Default                | Description                          |
|-----------------------|------------------------|--------------------------------------|
| `PORT`                | `3000`                 | Server port                          |
| `INSTANCE_NAME`       | `Node-App`             | Backend identifier                   |
| `DB_HOST`             | `172.17.0.63`          | PostgreSQL host                      |
| `DB_PORT`             | `5432`                 | PostgreSQL port                      |
| `DB_NAME`             | `chat_db`              | Database name                        |
| `DB_USER`             | `student`              | Database user                        |
| `DB_PASSWORD`         | `password123`          | Database password                    |
| `LB_URL`              | `http://172.17.0.62:3000` | Load balancer URL for heartbeats  |
| `HEARTBEAT_INTERVAL_MS` | `1000`               | Heartbeat send interval (ms)         |
| `SYNC_INTERVAL_MS`    | `500`                  | Cross-instance DB sync interval (ms) |
| `TLS_KEY`             | `key.pem`              | TLS key file path                    |
| `TLS_CERT`            | `cert.pem`             | TLS cert file path                   |
| `MASTER_KEY`          | `password`             | AES-256 master key passphrase        |
| `MASTER_SALT`         | `salt`                 | AES-256 key derivation salt          |

### Load Balancer (main.go)

| Variable              | Default                | Description                          |
|-----------------------|------------------------|--------------------------------------|
| `LB_PORT`             | `3000`                 | LB listening port                    |
| `BACKENDS`            | `https://172.17.0.63:3000,...` | Comma-separated backend URLs  |
| `OVERLOAD_THRESHOLD`  | `70`                   | Score threshold for overload (0–100) |
| `RECOVERY_THRESHOLD`  | `55`                   | Score threshold for recovery (0–100) |
| `HEARTBEAT_TIMEOUT`   | `3s`                   | Heartbeat stale timeout              |
| `RETRY_MAX`           | `2`                    | Max retries for POST /message        |
| `W_QUEUE`             | `0.40`                 | Queue length weight                  |
| `W_CPU`               | `0.20`                 | CPU usage weight                     |
| `W_MEMORY`            | `0.10`                 | Memory usage weight                  |
| `W_ACTIVE`            | `0.15`                 | Active requests weight               |
| `W_RESPTIME`          | `0.15`                 | Avg response time weight             |

---

## Maintenance

```bash
# Kill all Node.js backends
pgrep -f "node server/index.js" | xargs kill -9

# Kill Go LB
pgrep -f loadbalancer | xargs kill -9

# View logs
tail -f lb.log
tail -f sys2.log
tail -f sys3.log
tail -f sys4.log

# Check running processes
pgrep -fa node
pgrep -fa loadbalancer
```

## Internal Backend Routes

These are internal and not part of the required public API:

| Route        | Description                                   |
|--------------|-----------------------------------------------|
| `GET /health` | Backend health check (used by LB poller)    |
| `GET /metrics` | CPU, memory, queue, active, avg RT (JSON)  |

## Lab-6 Report Plots

Run the supplied load generator against the **Load Balancer only**. It records a time series from `/lb/metrics` while generating traffic:

```bash
node load_generator.js --url http://172.17.0.62:3000 --users 50 --duration 120 --minDelay 50 --maxDelay 500 --minLen 20 --maxLen 300 --feedRatio 0.3 --output results.json
python3 report_plots.py results.json plots
```

The plotting script creates response-time, CPU-utilization, memory-utilization, and backend-score plots. The metrics endpoint reports SYS1 plus SYS2/SYS3/SYS4, so the report can show utilization of all four systems.

## Threshold experiments

The default hysteresis is `OVERLOAD_THRESHOLD=70` and `RECOVERY_THRESHOLD=55`. For the report, repeat the same load profile with several thresholds (for example 60/45, 65/50, 70/55, 75/60), compare p95 response time, error rate, throughput, and backend utilization, and use the best stable setting for the final deployment. The supplied configuration does not hard-code round-robin routing.
