#!/usr/bin/env bash
set -u
echo "=== Professor deployment connectivity check ==="
for url in   http://172.17.0.63:3262/health   http://172.17.0.64:3263/health   http://172.17.0.65:3264/health   http://10.1.75.79:3261/lb/status; do
  echo "--- $url"
  curl --connect-timeout 3 --max-time 5 -sS "$url" || echo "FAILED"
  echo
done
