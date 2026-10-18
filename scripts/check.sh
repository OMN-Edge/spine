#!/usr/bin/env bash
# The checks CI runs, runnable on a laptop: ./scripts/check.sh [server|web|scan|all]
# SECURITY.md S-32 (dependencies) and S-36 (checks that are not the author of the change).
set -euo pipefail
cd "$(dirname "$0")/.."

server() { (cd server && npm ci && npx tsc --noEmit && npm test && npm audit --omit=dev --audit-level=high); }
web()    { (cd web && npm ci && npm run build && npm audit --omit=dev --audit-level=high); }
scan() {
  command -v gitleaks >/dev/null || { echo "gitleaks is not installed (brew install gitleaks)" >&2; exit 1; }
  command -v semgrep  >/dev/null || { echo "semgrep is not installed (brew install semgrep)" >&2; exit 1; }
  gitleaks detect --source . --redact
  scan_semgrep
}

# direct-response-write is written for Express: here `reply.send(object)` is serialised as JSON, and the only HTML sent
# is a constant page and the built app shell (checked 2026-10-18; re-check if a route sets `text/html`). Tests are not scanned.
scan_semgrep() {
  command -v semgrep >/dev/null || { echo "semgrep is not installed (brew install semgrep)" >&2; exit 1; }
  semgrep scan --error --metrics=off \
    --config p/typescript --config p/nodejs --config p/security-audit \
    --exclude-rule javascript.express.security.audit.xss.direct-response-write.direct-response-write \
    --exclude __tests__ --exclude __integration__ \
    server/src web/src
}

case "${1:-all}" in
  server) server ;;
  web) web ;;
  scan) scan ;;
  scan-semgrep) scan_semgrep ;;
  all) server; web; scan ;;
  *) echo "usage: $0 [server|web|scan|all]" >&2; exit 2 ;;
esac
