#!/usr/bin/env sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
name="mx-gateway-test-$$"
network="$name"

cleanup() {
  docker rm -f "$name-nginx" "$name-dropping" "$name-answering" "$name-slow-1" "$name-slow-2" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

engine() {
  docker run -d --name "$name-$1" --network "$network" --network-alias "$2" node:20-alpine \
    node -e "require('http').createServer((req, res) => { req.resume(); req.on('end', () => { $3 }); }).listen(3001)" >/dev/null
}

docker network create "$network" >/dev/null
engine dropping matching-engine-1 "req.socket.destroy();"
engine answering matching-engine-2 "res.end('answered');"
docker run -d --name "$name-nginx" --network "$network" -p 127.0.0.1::3001 \
  -v "$root/docker/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
port=$(docker port "$name-nginx" 3001 | head -n 1 | sed 's/.*://')

post() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port$1" -H 'content-type: application/json' -d '{}'
}

for attempt in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" != 000 ] && break
  sleep 1
done

for n in 1 2 3 4; do
  status=$(post /orders)
  if [ "$status" != 200 ]; then
    echo "FAIL: POST /orders answered $status; it should be retried on the other engine"
    exit 1
  fi
done
echo "OK: an order an engine dropped after receiving it is retried on the other engine"

sleep 3
dropped=0
for n in 1 2 3 4; do
  if [ "$(post /auth/refresh)" = 502 ]; then
    dropped=1
    break
  fi
  sleep 2.2
done
if [ "$dropped" != 1 ]; then
  echo "FAIL: POST /auth/refresh was replayed on the other engine after the first one received it"
  exit 1
fi
echo "OK: a refresh an engine already received is not replayed on the other engine"

docker rm -f "$name-nginx" "$name-dropping" "$name-answering" >/dev/null
slow="const delay = req.url.startsWith('/slow') ? 6000 : req.url.startsWith('/trades/summary') ? 5000 : 0; setTimeout(() => res.end('answered'), delay);"
engine slow-1 matching-engine-1 "$slow"
engine slow-2 matching-engine-2 "$slow"
docker run -d --name "$name-nginx" --network "$network" -p 127.0.0.1::3001 \
  -v "$root/docker/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
port=$(docker port "$name-nginx" 3001 | head -n 1 | sed 's/.*://')
for attempt in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" = 200 ] && break
  sleep 1
done

status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/trades/summary")
if [ "$status" != 200 ]; then
  echo "FAIL: a trade summary that takes 5 s answered $status"
  exit 1
fi
echo "OK: a slow trade summary for reconciliation is not cut off"

curl -s -o /dev/null "http://127.0.0.1:$port/slow" || true
status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/orders/book")
if [ "$status" != 200 ]; then
  echo "FAIL: after one slow request timed out, the next request answered $status"
  exit 1
fi
echo "OK: one slow request does not take both engines out of rotation"
