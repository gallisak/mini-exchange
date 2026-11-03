#!/usr/bin/env sh
set -eu

ENGINE_URL="${ENGINE_URL:-http://localhost:3001}"
SETTLEMENT_URL="${SETTLEMENT_URL:-http://localhost:3002}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
TIMEOUT="${SMOKE_TIMEOUT:-120}"

wait_for() {
  name="$1"
  shift
  deadline=$(($(date +%s) + TIMEOUT))
  until "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "FAIL: $name did not respond within ${TIMEOUT}s"
      return 1
    fi
    sleep 2
  done
  echo "OK: $name"
}

email="smoke-$(date +%s)@example.com"

wait_for "matching-engine-service registers a user" \
  curl -fsS -X POST "$ENGINE_URL/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"password123\"}"

wait_for "settlement-service answers HTTP" \
  curl -sS -o /dev/null "$SETTLEMENT_URL/"

wait_for "frontend serves the order book page" \
  curl -fsS "$FRONTEND_URL/orderbook"
