#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${1:-$ROOT/supervisor/remote.example.json}"

cd "$ROOT"
npm run build
exec npm run supervisor:start -- "$CONFIG"
