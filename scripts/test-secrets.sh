#!/usr/bin/env sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'docker run --rm -v "$work:/work" alpine:3.20 rm -rf /work/run >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

generate() {
  docker run --rm -v "$root/docker/secrets:/opt/secrets:ro" -v "$work/run:/run/exchange" alpine:3.20 \
    sh /opt/secrets/generate.sh >/dev/null
}

value() {
  sed -n "s/^$2=//p" "$work/run/$1/secrets.env"
}

fail() {
  echo "FAIL: $1"
  exit 1
}

mkdir -p "$work/run/engine" "$work/run/settlement" "$work/run/frontend"
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
if grep -q JWT "$work/run/frontend/secrets.env" || grep -q JWT_REFRESH_SECRET "$work/run/settlement/secrets.env"; then
  fail "a service sees a secret that is not its own"
fi
echo "OK: every service gets its own keys, shared where they must match"

first=$(value engine JWT_ACCESS_SECRET)
generate
[ "$(value engine JWT_ACCESS_SECRET)" = "$first" ] || fail "a second start replaced the secrets"
echo "OK: a restart keeps the secrets"

printf 'JWT_ACCESS_SECRET=old\nENGINE_INTERNAL_KEY=old\n' > "$work/run/settlement/secrets.env"
generate
[ "$(value settlement SETTLEMENT_INTERNAL_KEY | wc -c)" -gt 60 ] || fail "an older installation never got the settlement key"
[ "$(value settlement JWT_ACCESS_SECRET)" = "$(value engine JWT_ACCESS_SECRET)" ] || fail "regenerating left the services out of step"
echo "OK: an installation from before the settlement key gets a complete new set"
