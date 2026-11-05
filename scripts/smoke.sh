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
    -H "x-request-id: ${3:-smoke-$2-$(date +%s)}" \
    -H 'content-type: application/json' \
    -d "{\"instrument\":\"ABC\",\"side\":\"$2\",\"price\":\"10.00\",\"quantity\":\"1\"}" >/dev/null
}

asset_balance() {
  curl -fsS "$SETTLEMENT_URL/wallets/me" -H "authorization: Bearer $1" |
    jq -r --arg asset "$2" '.balances[] | select(.asset == $asset) | .balance'
}

wait_for "matching-engine-service reports healthy" curl -fsS "$ENGINE_URL/health"
wait_for "settlement-service reports healthy" curl -fsS "$SETTLEMENT_URL/health"

seller=$(token_for seller)
buyer=$(token_for buyer)
trace_id="smoke-trace-$(date +%s)"
start_usd=$(asset_balance "$buyer" USD)
place_order "$seller" sell
place_order "$buyer" buy "$trace_id"

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
  sh /opt/secrets/with-secrets.sh node dist/reconciliation/reconcile.js) || {
  echo "FAIL: reconciliation did not match"
  echo "$report"
  exit 1
}
echo "OK: reconciliation matches $(echo "$report" | jq -c '[.instruments[] | {instrument, trades: .ledger.count}]')"

traced_in_both_services() {
  logs=$($COMPOSE logs --no-color matching-engine-1 matching-engine-2 settlement-service 2>/dev/null |
    grep "\"traceId\":\"$trace_id\"")
  echo "$logs" | grep -q '"service":"matching-engine-service".*"message":"Trade .* executed' &&
    echo "$logs" | grep -q '"service":"settlement-service".*"message":"Trade .* settled'
}
wait_for "trace $trace_id runs from the order request to settlement" traced_in_both_services

flooder=$(token_for flooder)
limited=$(seq 1 40 | xargs -P 40 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST "$ENGINE_URL/orders" \
  -H "authorization: Bearer $flooder" -H "idempotency-key: flood-{}-$(date +%s)" \
  -H 'content-type: application/json' \
  -d '{"instrument":"DEF","side":"buy","price":"1.00","quantity":"1"}' | grep -c '^429$' || true)
if [ "$limited" -lt 1 ]; then
  echo "FAIL: 40 orders at once from one user were never rate limited"
  exit 1
fi
echo "OK: flooding orders was answered with 429 ($limited of 40)"

for docs in "$ENGINE_URL/docs-json" "$SETTLEMENT_URL/docs-json"; do
  curl -fsS "$docs" | jq -e '.paths | length > 0' >/dev/null
done
echo "OK: both services publish OpenAPI documents"

book_seq=$(curl -fsS "$ENGINE_URL/orders/book?instrument=ABC" | jq -r .seq)
case "$book_seq" in
  '' | *[!0-9]* | 0)
    echo "FAIL: the public order book has no sequence number ($book_seq)"
    exit 1
    ;;
esac
echo "OK: the public order book is at seq $book_seq"

spoofed=$(seq 1 12 | while read -r n; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$ENGINE_URL/auth/login" \
    -H "x-forwarded-for: 10.9.8.$n" -H 'content-type: application/json' \
    -d '{"email":"nobody@example.com","password":"wrong-password"}'
done | grep -c '^429$' || true)
if [ "$spoofed" -lt 1 ]; then
  echo "FAIL: a forged X-Forwarded-For header gets around the login rate limit"
  exit 1
fi
echo "OK: forging X-Forwarded-For does not get around the login rate limit"

wait_for "frontend serves the order book page" \
  curl -fsS "$FRONTEND_URL/orderbook"

jar=$(mktemp)
curl -fsS -c "$jar" -X POST "$FRONTEND_URL/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"frontend-$(date +%s)@example.com\",\"password\":\"password123\"}" >/dev/null
grep -q 'HttpOnly_.*mx_refresh' "$jar" || { echo "FAIL: the frontend did not keep the session in an httpOnly cookie"; exit 1; }
curl -fsS -b "$jar" -X POST "$FRONTEND_URL/api/orders" -H 'content-type: application/json' \
  -H "idempotency-key: frontend-$(date +%s)" \
  -d '{"instrument":"XYZ","side":"buy","price":"1.00","quantity":"1"}' | jq -e '.status == "accepted"' >/dev/null
curl -fsS -b "$jar" "$FRONTEND_URL/api/wallet" | jq -e '.balances | length == 4' >/dev/null
rm -f "$jar"
echo "OK: the frontend signs in with httpOnly cookies, places an order and reads the wallet"

forged=$(seq 1 12 | while read -r n; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$FRONTEND_URL/api/auth/login" \
    -H "x-forwarded-for: 10.9.7.$n" -H 'content-type: application/json' \
    -d '{"email":"nobody@example.com","password":"wrong-password"}'
done | grep -c '^429$' || true)
if [ "$forged" -lt 1 ]; then
  echo "FAIL: a forged X-Forwarded-For header gets around the login rate limit through the frontend"
  exit 1
fi
echo "OK: forging X-Forwarded-For through the frontend does not get around the login rate limit"
