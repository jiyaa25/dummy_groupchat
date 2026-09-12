#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a
export INSTANCE_NAME=SYS2 PORT=3262 DB_HOST=172.17.0.63 LB_URL=http://10.1.75.79:3261
exec node server/index.js
