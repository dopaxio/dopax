#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_TAG="${1:-matrix-agent-codex-runtime:local}"
CODEX_NPM_PACKAGE="${CODEX_NPM_PACKAGE:-@openai/codex@latest}"

docker build \
  -t "$IMAGE_TAG" \
  --build-arg "CODEX_NPM_PACKAGE=$CODEX_NPM_PACKAGE" \
  -f "$ROOT/containers/codex-runtime/Dockerfile" \
  "$ROOT/containers/codex-runtime"

echo "Built $IMAGE_TAG"
