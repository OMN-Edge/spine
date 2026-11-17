#!/usr/bin/env bash
# Builds the server's and the relay's images and pushes them to any registry, tagged:
#   ./scripts/publish-images.sh REGISTRY_PREFIX [TAG]
# REGISTRY_PREFIX is everything before the image name: europe-west4-docker.pkg.dev/PROJECT/spine, ghcr.io/OWNER, docker.io/NAME, registry.example.com:5000/spine.
# TAG defaults to the short commit. The images are REGISTRY_PREFIX/spine:TAG and REGISTRY_PREFIX/spine-relay:TAG, and the tree must be clean so a tag names one commit.
# Sign in to the registry first (docker login, or gcloud auth configure-docker europe-west4-docker.pkg.dev). Needs docker with buildx.
# PLATFORMS (default linux/amd64, what Cloud Run runs; linux/amd64,linux/arm64 adds the Pi), DRY_RUN=1 prints the commands and runs none.
set -euo pipefail
cd "$(dirname "$0")/.."
prefix="${1:?usage: $0 REGISTRY_PREFIX [TAG]}"
prefix="${prefix%/}"
commit="$(git rev-parse HEAD)"
tag="${2:-$(git rev-parse --short HEAD)}"
platforms="${PLATFORMS:-linux/amd64}"
[ -z "$(git status --porcelain)" ] || { echo "the tree is not clean" >&2; exit 1; }
run() { if [ -n "${DRY_RUN:-}" ]; then printf '%q ' "$@"; echo; else "$@"; fi; }
[ -n "${DRY_RUN:-}" ] || docker buildx version >/dev/null || { echo "docker buildx is needed" >&2; exit 1; }
run docker buildx build --platform "$platforms" --push --build-arg "SPINE_COMMIT=$commit" -t "$prefix/spine:$tag" .
run docker buildx build --platform "$platforms" --push -f relay.Dockerfile -t "$prefix/spine-relay:$tag" .
echo "pushed $prefix/spine:$tag and $prefix/spine-relay:$tag ($platforms)"
