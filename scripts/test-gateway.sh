#!/usr/bin/env sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
name="mx-gateway-test-$$"
network="$name"

cleanup() {
  docker rm -f "$name-nginx" "$name-dropping" "$name-answering" "$name-refusing" "$name-summing" "$name-slow-1" "$name-slow-2" "$name-hanging" "$name-quick" >/dev/null 2>&1 || true
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

for attempt in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" != 000 ] && break
  sleep 1
done

for path in /orders /auth/refresh; do
  method=POST
  sleep 3
  dropped=0
  for n in 1 2 3 4; do
    status=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "http://127.0.0.1:$port$path" -H 'content-type: application/json' -d '{}')
    if [ "$status" = 503 ]; then
      dropped=1
      break
    fi
    sleep 2.2
  done
  if [ "$dropped" != 1 ]; then
    echo "FAIL: $method $path was replayed on the other engine after the first one received it"
    exit 1
  fi
  echo "OK: $method $path that an engine already received is not replayed on the other engine"
done

sleep 3
dropped=0
for n in 1 2 3 4; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/trades/summary")
  if [ "$status" = 503 ]; then
    dropped=1
    break
  fi
  sleep 2.2
done
if [ "$dropped" != 1 ]; then
  echo "FAIL: a trade summary was run again on the other engine after the connection broke"
  exit 1
fi
echo "OK: a trade summary whose connection broke is not run again on the other engine"

docker rm -f "$name-nginx" "$name-dropping" "$name-answering" >/dev/null
engine refusing matching-engine-1 "res.statusCode = 503; res.end('refused');"
engine summing matching-engine-2 "res.end('answered');"
docker run -d --name "$name-nginx" --network "$network" -p 127.0.0.1::3001 \
  -v "$root/docker/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
port=$(docker port "$name-nginx" 3001 | head -n 1 | sed 's/.*://')
for attempt in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" != 000 ] && break
  sleep 1
done
sleep 3
refused=0
for n in 1 2 3 4; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/trades/summary")
  [ "$status" = 503 ] && refused=1
done
if [ "$refused" != 1 ]; then
  echo "FAIL: a trade summary answered 503 was run again on the other engine"
  exit 1
fi
echo "OK: a trade summary one engine gave up on is not run again on the other one"

docker rm -f "$name-nginx" "$name-refusing" "$name-summing" >/dev/null
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

sleep 3
answer=$(curl -s -w ' %{http_code}' "http://127.0.0.1:$port/slow")
case "$answer" in
  *'"statusCode":503'*' 503') ;;
  *)
    echo "FAIL: a request both engines left unanswered got: $answer"
    exit 1
    ;;
esac
echo "OK: a request no engine answers in time is told 503, as the API promises, not 504"

sleep 3
for n in 1 2 3 4; do
  curl -s -o /dev/null -X POST "http://127.0.0.1:$port/slow" &
done
wait
status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/orders/book")
if [ "$status" != 503 ]; then
  echo "FAIL: with both engines out of rotation the API answered $status"
  exit 1
fi
echo "OK: with both engines out of rotation the API still answers 503, not 502"
status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/socket.io/?EIO=4&transport=polling")
if [ "$status" != 200 ]; then
  echo "FAIL: API timeouts took the WebSocket connections down too: $status"
  exit 1
fi
echo "OK: API timeouts do not take the engines out of rotation for WebSocket connections"

docker rm -f "$name-nginx" "$name-slow-1" "$name-slow-2" >/dev/null
engine hanging matching-engine-1 "if (req.url.startsWith('/slow')) return; res.end('engine-1');"
engine quick matching-engine-2 "res.end('engine-2');"
docker run -d --name "$name-nginx" --network "$network" -p 127.0.0.1::3001 \
  -v "$root/docker/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
port=$(docker port "$name-nginx" 3001 | head -n 1 | sed 's/.*://')
for attempt in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" = 200 ] && break
  sleep 1
done
sleep 3

for attempt in 1 2 3; do
  took=$(curl -s -o /dev/null -w '%{time_total}' "http://127.0.0.1:$port/slow")
  [ "${took%%.*}" -ge 4 ] && break
done
answers=$(for n in 1 2 3 4 5 6; do curl -s "http://127.0.0.1:$port/orders/book"; echo; done)
if ! echo "$answers" | grep -q engine-1; then
  echo "FAIL: one timed out request took engine-1 out of rotation: $(echo "$answers" | tr '\n' ' ')"
  exit 1
fi
echo "OK: one timed out request does not take an engine out of rotation"

