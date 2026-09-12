#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a
export LB_PORT=3261 BACKEND_1_URL=http://172.17.0.63:3262 BACKEND_2_URL=http://172.17.0.64:3263 BACKEND_3_URL=http://172.17.0.65:3264
exec node lb/server.js
