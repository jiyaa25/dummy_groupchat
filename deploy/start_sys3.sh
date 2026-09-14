#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ulimit -n 65535 2>/dev/null || true
set -a
source .env
set +a
export INSTANCE_NAME=SYS3 PORT=3000 DB_HOST=172.17.0.63 LB_URL=http://172.17.0.62:3000
exec node daemon.js server/index.js /home/student/backend.log
