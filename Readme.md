# Distributed Secure Group Chat — Professor Deployment

## Fixed four-system network

| System | Role | Address | Port |
|---|---|---|---:|
| SYS1 | Load Balancer | `10.1.75.79` | `3261` |
| SYS2 | Backend + PostgreSQL | `172.17.0.63` | `3262` |
| SYS3 | Backend | `172.17.0.64` | `3263` |
| SYS4 | Backend | `172.17.0.65` | `3264` |

**Final evaluator URL:** `http://10.1.75.79:3261`

SYS1 is the only URL that should be given to the evaluator. The `172.17.x.x` addresses are backend/database routing addresses.

## What was fixed

The project previously contained deployment defaults for port `5000`, `127.0.0.1`, and old `172.17.0.51/.52/.53` addresses. These have been replaced in the deployment/runtime defaults.

The shared PostgreSQL host is now `172.17.0.63`.

The old silent in-memory database fallback is disabled for deployment. Without this change, a PostgreSQL connectivity failure could make each backend use its own private memory store, which is not a valid distributed deployment.

The browser chat now uses a single WebSocket transport so Socket.IO does not depend on sticky HTTP polling sessions while the LB dynamically routes requests.

## 1. Install

```bash
cd Group_Chat_Web_Application
cp .env.example .env
npm install
```

Do not change the assigned ports.

## 2. PostgreSQL on SYS2

PostgreSQL must be reachable by SYS3 and SYS4.

If the database/user do not already exist:

```bash
sudo -u postgres psql -c "CREATE DATABASE chat_db;"
sudo -u postgres psql -c "CREATE USER student WITH PASSWORD 'password123';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE chat_db TO student;"
sudo -u postgres psql -d chat_db -c "GRANT ALL ON SCHEMA public TO student;"
```

Configure PostgreSQL to listen on the required interface (`listen_addresses='*'`) and allow the backend nodes in `pg_hba.conf`, for example:

```text
host    chat_db    student    172.17.0.0/16    scram-sha-256
```

Use the authentication method already configured for your PostgreSQL installation if it differs.

Restart:

```bash
sudo systemctl restart postgresql
```

From SYS3/SYS4 verify:

```bash
nc -vz 172.17.0.63 5432
```

## 3. Start SYS2

Terminal 1:

```bash
cd Group_Chat_Web_Application
./deploy/start_sys2.sh
```

Expected:

```text
[SYS2] Backend server listening on port 3262
[Heartbeat] Starting heartbeat client for SYS2 -> http://10.1.75.79:3261
```

## 4. Start SYS3

Terminal 2:

```bash
cd Group_Chat_Web_Application
./deploy/start_sys3.sh
```

Expected port: `3263`.

## 5. Start SYS4

Terminal 3:

```bash
cd Group_Chat_Web_Application
./deploy/start_sys4.sh
```

Expected port: `3264`.

## 6. Start SYS1 Load Balancer

Start after all three backends:

```bash
cd Group_Chat_Web_Application
./deploy/start_lb.sh
```

Expected:

```text
[Sys1] Dynamic Load Balancer listening on port 3261
```

## 7. Verify before giving the professor the URL

Run:

```bash
./deploy/check.sh
```

Then:

```bash
curl http://10.1.75.79:3261/lb/status
```

SYS2, SYS3 and SYS4 should all eventually show:

```json
"healthy": true
```

Also:

```bash
curl http://10.1.75.79:3261/lb/metrics
```

Only after this succeeds, open:

```text
http://10.1.75.79:3261
```

## 8. API tests through the LB

```bash
curl -X POST http://10.1.75.79:3261/message   -H "Content-Type: application/json"   -d '{"client-name":"Alice","msg":"Hello Distributed Systems!","message_id":"test-001"}'
```

Then:

```bash
curl http://10.1.75.79:3261/feed
```

And:

```bash
curl http://10.1.75.79:3261/lb/status
curl http://10.1.75.79:3261/lb/metrics
```

## 9. Load generator

```bash
python3 load_generator/load_generator.py   --url http://10.1.75.79:3261   --users 50   --duration 60   --mode mixed
```

Experiments:

```bash
python3 experiments/run_experiments.py   --url http://10.1.75.79:3261
```

## 10. Tests

`npm test` is an isolated test suite. Its npm script explicitly enables the mock DB only for those tests. The real deployment has `ALLOW_MOCK_DB=false`.

The live E2E test uses the assigned addresses/ports.

## 11. If it does not work

Do **not** change back to port 5000 or `127.0.0.1`.

Check in this order:

```bash
ss -lntp | grep -E ':3261|:3262|:3263|:3264'
```

```bash
curl http://172.17.0.63:3262/health
curl http://172.17.0.64:3263/health
curl http://172.17.0.65:3264/health
```

From SYS3 and SYS4:

```bash
nc -vz 172.17.0.63 5432
```

Then:

```bash
curl http://10.1.75.79:3261/lb/status
```

If a backend health check works locally but SYS1 reports it unhealthy, the problem is almost certainly network reachability between SYS1 and the `172.17.x.x` backend address, not the application port configuration.

## Architecture

```text
                    Evaluator / Browser
                           |
                           v
                10.1.75.79:3261
                       SYS1 LB
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
  172.17.0.63:3262  172.17.0.64:3263  172.17.0.65:3264
       SYS2               SYS3               SYS4
          |                |                |
          +----------------+----------------+
                           |
                           v
                 PostgreSQL 172.17.0.63:5432
```
