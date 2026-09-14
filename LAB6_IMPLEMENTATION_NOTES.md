# Lab 6 Backend Implementation Notes

## What was verified/fixed

### Lab 5 functionality retained
- Shared persistent PostgreSQL storage remains the source of truth.
- AES-256-GCM encryption/decryption is restored as a dedicated backend module.
- ECDSA P-256 signatures are verified for Socket.IO chat messages.
- Room capacity (4), duplicate username protection, typing indicators, leave/disconnect handling, message history, and real-time chat events are retained.
- Existing database rows are migrated instead of being deleted.

### Lab 6 requirements
- SYS1 is the only client-facing endpoint: `172.17.0.62:3000`.
- Required public routes remain exactly `POST /message` and `GET /feed`.
- SYS1 dynamically scores SYS2/SYS3/SYS4 using queue, CPU, memory, active requests, and response time.
- `OVERLOAD_THRESHOLD` and `RECOVERY_THRESHOLD` implement hysteresis, avoiding rapid route oscillation.
- Backends send heartbeat telemetry every second.
- SYS1 actively polls backend `/health` and removes nodes after repeated failures/stale heartbeats.
- Persistent HTTP keep-alive is used for upstream traffic.
- WebSocket upgrade is proxied and pinned to the selected backend for the lifetime of the connection.
- `message_id` is unique in PostgreSQL and inserts use `ON CONFLICT DO NOTHING`.
- Duplicate REST retries return the existing message without inserting another row or emitting a second Socket.IO message.
- The supplied load generator supports variable users, message lengths, and inter-request delays.
- The load generator records `/lb/metrics` samples for report plots.
- `report_plots.py` generates response-time, CPU, memory, and backend-score plots.

## Threshold experiment recommendation

The shipped baseline is:

- overload: 70
- recovery: 55
- queue weight: 0.40
- CPU weight: 0.20
- memory weight: 0.10
- active-request weight: 0.15
- response-time weight: 0.15

Run the same workload with several threshold pairs and choose the setting with the best p95 latency/error-rate/throughput trade-off. Do not claim a threshold is optimal until it has been measured on the allotted systems.

## Deployment

The existing IP addresses and ports are intentionally unchanged. Use the supplied deployment scripts. They source `.env`, install dependencies with `npm install`, start SYS2/SYS3/SYS4, then start SYS1.

`server/db.js` automatically performs the database migration on startup, so an existing Lab-5 database is not intentionally wiped.
