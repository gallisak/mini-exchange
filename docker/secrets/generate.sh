#!/bin/sh
set -eu

root=/run/exchange
if [ -s "$root/engine/secrets.env" ] && [ -s "$root/settlement/secrets.env" ] &&
  [ -s "$root/frontend/secrets.env" ]; then
  exit 0
fi

key() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

access=$(key)
refresh=$(key)
proxy=$(key)
internal=$(key)

write() {
  dir="$root/$1"
  shift
  umask 077
  printf '%s\n' "$@" > "$dir/secrets.env.tmp"
  chown 1000:1000 "$dir/secrets.env.tmp"
  mv "$dir/secrets.env.tmp" "$dir/secrets.env"
}

write engine \
  "JWT_ACCESS_SECRET=$access" \
  "JWT_REFRESH_SECRET=$refresh" \
  "FRONTEND_PROXY_KEY=$proxy" \
  "ENGINE_INTERNAL_KEY=$internal"
write settlement \
  "JWT_ACCESS_SECRET=$access" \
  "ENGINE_INTERNAL_KEY=$internal"
write frontend \
  "FRONTEND_PROXY_KEY=$proxy"
echo "Generated new secrets"
