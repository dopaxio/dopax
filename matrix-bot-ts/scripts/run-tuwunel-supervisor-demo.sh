#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/.data/tuwunel-supervisor-demo}"
IMAGE="${IMAGE:-docker.io/jevolk/tuwunel:latest}"
PORT="${PORT:-6167}"
CONTAINER_NAME="${CONTAINER_NAME:-tuwunel-supervisor-demo}"
NETWORK="${NETWORK:-element-docker-demo_backend}"

mkdir -p "$DATA_DIR"

docker rm -f tuwunel-local "$CONTAINER_NAME" >/dev/null 2>&1 || true

exec docker run --rm \
  --name "$CONTAINER_NAME" \
  --network "$NETWORK" \
  --network-alias "tuwunel-local" \
  -p "$PORT:$PORT" \
  -v "$DATA_DIR:/var/lib/tuwunel" \
  -e TUWUNEL_SERVER_NAME="tuwunel.dev.localhost" \
  -e TUWUNEL_DATABASE_PATH="/var/lib/tuwunel" \
  -e TUWUNEL_PORT="$PORT" \
  -e TUWUNEL_ADDRESS="0.0.0.0" \
  -e TUWUNEL_MAX_REQUEST_SIZE="50000000" \
  -e TUWUNEL_ALLOW_REGISTRATION="true" \
  -e TUWUNEL_YES_I_AM_VERY_VERY_SURE_I_WANT_AN_OPEN_REGISTRATION_SERVER_PRONE_TO_ABUSE="true" \
  -e TUWUNEL_ALLOW_FEDERATION="false" \
  "$IMAGE"
