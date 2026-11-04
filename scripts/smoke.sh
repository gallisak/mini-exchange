#!/usr/bin/env sh
set -eu

ENGINE_URL="${ENGINE_URL:-http://localhost:3001}"
SETTLEMENT_URL="${SETTLEMENT_URL:-http://localhost:3002}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
TIMEOUT="${SMOKE_TIMEOUT:-120}"
COMPOSE="${COMPOSE:-docker compose}"

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

token_for() {
  curl -fsS -X POST "$ENGINE_URL/auth/register" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$1-$(date +%s)@example.com\",\"password\":\"password123\"}" | jq -r .accessToken
}

place_order() {
  curl -fsS -X POST "$ENGINE_URL/orders" \
    -H "authorization: Bearer $1" \
    -H "idempotency-key: smoke-$2-$(date +%s)" \
    -H 'content-type: application/json' \
    -d "{\"instrument\":\"ABC\",\"side\":\"$2\",\"price\":\"10.00\",\"quantity\":\"1\"}" >/dev/null
}

asset_balance() {
  curl -fsS "$SETTLEMENT_URL/wallets/me" -H "authorization: Bearer $1" |
    jq -r --arg asset "$2" '.balances[] | select(.asset == $asset) | .balance'
}

seller=$(token_for seller)
buyer=$(token_for buyer)
start_usd=$(asset_balance "$buyer" USD)
place_order "$seller" sell
place_order "$buyer" buy

buyer_received_abc() {
  [ "$(asset_balance "$buyer" ABC)" = '1001.00000000' ]
}

wait_for "a matched trade reaches the buyer's wallet" buyer_received_abc

buyer_usd=$(asset_balance "$buyer" USD)
seller_usd=$(asset_balance "$seller" USD)
seller_abc=$(asset_balance "$seller" ABC)
if [ "$start_usd" != "100000.00" ] || [ "$buyer_usd" != "99990.00" ] ||
  [ "$seller_usd" != "100010.00" ] || [ "$seller_abc" != "999.00000000" ]; then
  echo "FAIL: buyer USD $start_usd -> $buyer_usd, seller USD $seller_usd and ABC $seller_abc"
  exit 1
fi
echo "OK: buyer paid 10.00 USD to the seller for 1 ABC"

report=$($COMPOSE exec -T -e RECONCILIATION_LAG_MS=0 settlement-service \
  node dist/reconciliation/reconcile.js) || {
  echo "FAIL: reconciliation did not match"
  echo "$report"
  exit 1
}
echo "OK: reconciliation matches $(echo "$report" | jq -c '[.instruments[] | {instrument, trades: .ledger.count}]')"

wait_for "frontend serves the order book page" \
  curl -fsS "$FRONTEND_URL/orderbook"
