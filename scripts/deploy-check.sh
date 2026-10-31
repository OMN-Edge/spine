#!/usr/bin/env bash
# After an official deploy: ./scripts/deploy-check.sh vX.Y.Z
# Checks that the web app built here is the one the release workflow built and signed for that tag: the release's hashes.txt must carry a valid
# attestation (made by this repository's release workflow) and be the same list as web/dist/hashes.txt. Needs the GitHub CLI (`gh`), and the tag checked out clean:
#   git checkout vX.Y.Z && ./install.sh -b && sudo systemctl restart spine-web && ./scripts/deploy-check.sh vX.Y.Z
set -euo pipefail
cd "$(dirname "$0")/.."
tag="${1:?usage: $0 vX.Y.Z}"
repo="${SPINE_REPO:-$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"
command -v gh >/dev/null || { echo "gh (the GitHub CLI) is needed" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$tag^{commit}")" ] || { echo "HEAD is not $tag: git checkout $tag, and build" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "the tree is not clean" >&2; exit 1; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
gh release download "$tag" --repo "$repo" --pattern hashes.txt --dir "$work"
gh attestation verify "$work/hashes.txt" --repo "$repo" --signer-workflow "$repo/.github/workflows/release.yml"
diff "$work/hashes.txt" web/dist/hashes.txt && echo "ok: web/dist is the build $repo's release workflow signed for $tag"
