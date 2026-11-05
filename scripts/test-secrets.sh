#!/usr/bin/env sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
volume="mx-secrets-test-$$"
trap 'docker volume rm -f "$volume" >/dev/null 2>&1 || true' EXIT

generate() {
  docker run --rm -v "$root/docker/secrets:/opt/secrets:ro" -v "$volume:/run/exchange" alpine:3.20 \
    sh /opt/secrets/generate.sh >/dev/null
}

inside() {
  docker run --rm -i -v "$volume:/run/exchange" alpine:3.20 sh -c "$1"
}

value() {
  inside "sed -n 's/^$2=//p' /run/exchange/$1/secrets.env"
}

fail() {
  echo "FAIL: $1"
  exit 1
}

docker volume create "$volume" >/dev/null
inside 'mkdir -p /run/exchange/engine /run/exchange/settlement /run/exchange/frontend'
generate

for pair in engine:JWT_ACCESS_SECRET engine:JWT_REFRESH_SECRET engine:FRONTEND_PROXY_KEY engine:ENGINE_INTERNAL_KEY \
  settlement:JWT_ACCESS_SECRET settlement:ENGINE_INTERNAL_KEY settlement:SETTLEMENT_INTERNAL_KEY \
  frontend:FRONTEND_PROXY_KEY; do
  service=${pair%%:*}
  key=${pair#*:}
  [ "$(value "$service" "$key" | wc -c)" -gt 60 ] || fail "$service has no $key"
done
[ "$(value engine JWT_ACCESS_SECRET)" = "$(value settlement JWT_ACCESS_SECRET)" ] || fail "engine and settlement sign with different keys"
[ "$(value engine ENGINE_INTERNAL_KEY)" = "$(value settlement ENGINE_INTERNAL_KEY)" ] || fail "settlement cannot call the engine"
[ "$(value engine FRONTEND_PROXY_KEY)" = "$(value frontend FRONTEND_PROXY_KEY)" ] || fail "the frontend proxy key differs"
if inside 'grep -q JWT /run/exchange/frontend/secrets.env || grep -q JWT_REFRESH_SECRET /run/exchange/settlement/secrets.env'; then
  fail "a service sees a secret that is not its own"
fi
[ "$(inside 'stat -c %u:%a /run/exchange/engine/secrets.env /run/exchange/settlement/secrets.env /run/exchange/frontend/secrets.env' | sort -u)" = '1000:600' ] ||
  fail "a secrets file is not private to the node user"
echo "OK: every service gets its own keys, shared where they must match, readable only by its user"

first=$(value engine JWT_ACCESS_SECRET)
generate
[ "$(value engine JWT_ACCESS_SECRET)" = "$first" ] || fail "a second start replaced the secrets"
echo "OK: a restart keeps the secrets"

inside "printf 'JWT_ACCESS_SECRET=old\\nENGINE_INTERNAL_KEY=old\\n' > /run/exchange/settlement/secrets.env"
generate
[ "$(value settlement SETTLEMENT_INTERNAL_KEY | wc -c)" -gt 60 ] || fail "an older installation never got the settlement key"
[ "$(value settlement JWT_ACCESS_SECRET)" = "$(value engine JWT_ACCESS_SECRET)" ] || fail "regenerating left the services out of step"
echo "OK: an installation from before the settlement key gets a complete new set"
