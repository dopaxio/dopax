#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_TAG="${1:-matrix-agent-opencode-runtime:local}"
OPENCODE_NPM_PACKAGE="${OPENCODE_NPM_PACKAGE:-opencode-ai@latest}"

docker build \
  -t "$IMAGE_TAG" \
  --build-arg "OPENCODE_NPM_PACKAGE=$OPENCODE_NPM_PACKAGE" \
  -f "$ROOT/containers/opencode-runtime/Dockerfile" \
  "$ROOT/containers/opencode-runtime"

echo "Built $IMAGE_TAG"
