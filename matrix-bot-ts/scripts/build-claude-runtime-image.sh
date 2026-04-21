#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_TAG="${1:-matrix-agent-claude-runtime:local}"
CLAUDE_NPM_PACKAGE="${CLAUDE_NPM_PACKAGE:-@anthropic-ai/claude-code@latest}"

docker build \
  -t "$IMAGE_TAG" \
  --build-arg "CLAUDE_NPM_PACKAGE=$CLAUDE_NPM_PACKAGE" \
  -f "$ROOT/containers/claude-runtime/Dockerfile" \
  "$ROOT/containers/claude-runtime"

echo "Built $IMAGE_TAG"
