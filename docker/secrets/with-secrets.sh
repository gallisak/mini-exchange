#!/bin/sh
set -eu

set -a
. /run/exchange/secrets.env
set +a
exec "$@"
