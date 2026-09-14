#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ulimit -n 65535 2>/dev/null || true
set -a
source .env
set +a
export LB_PORT=3000 BACKEND_1_URL=http://172.17.0.63:3000 BACKEND_2_URL=http://172.17.0.64:3000 BACKEND_3_URL=http://172.17.0.65:3000
exec node daemon.js lb/server.js /home/student/lb.log
