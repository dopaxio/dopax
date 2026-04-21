#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_TAG="${1:-matrix-agent-gemini-runtime:local}"
GEMINI_NPM_PACKAGE="${GEMINI_NPM_PACKAGE:-@google/gemini-cli@latest}"

docker build \
  -t "$IMAGE_TAG" \
  --build-arg "GEMINI_NPM_PACKAGE=$GEMINI_NPM_PACKAGE" \
  -f "$ROOT/containers/gemini-runtime/Dockerfile" \
  "$ROOT/containers/gemini-runtime"

echo "Built $IMAGE_TAG"
