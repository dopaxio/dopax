#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"

if [ -z "$NODE_BIN" ]; then
  echo "Unable to resolve node from PATH. Set NODE_BIN to an absolute Node.js binary." >&2
  exit 1
fi

cd "$ROOT"
exec "$NODE_BIN" dist/index.js
