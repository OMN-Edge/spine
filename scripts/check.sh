#!/usr/bin/env bash
# The checks CI runs, runnable on a laptop: ./scripts/check.sh [server|web|repro|scan|all]; `browser` is the two real-browser checks, which CI also runs
# SECURITY.md S-32 (dependencies) and S-36 (checks that are not the author of the change).
set -euo pipefail
cd "$(dirname "$0")/.."

# One install for the workspaces (core, anaf, billing, server, web); core is built first because the others use it, and anaf and billing before the server, which uses them.
server() { npm ci && npm run build:core && npm run build:anaf && npm run build:billing && npm run typecheck -w spine-core && npm test -w spine-core && npm run test:accounts -w spine-core \
  && npm run typecheck -w spine-anaf && npm test -w spine-anaf && npm run typecheck -w spine-billing && npm test -w spine-billing \
  && npm run typecheck -w spine-server && npm test -w spine-server && npm run test:accounts -w spine-server \
  && npm run build -w spine-server && npm run smoke -w spine-server && npm audit --omit=dev --audit-level=high; }
web()    { npm ci && npm run build:libs && npm test -w spine-web && npm run build -w spine-web && npm audit --omit=dev --audit-level=high; }
# The web app builds to the same files twice: hashes.txt (what a site publishes and verify-build.mjs compares) must not depend on the run.
repro()   { npm ci && npm run build:libs && npm run build -w spine-web && cp web/dist/hashes.txt "${TMPDIR:-/tmp}/spine-hashes-1.txt" \
  && npm run build -w spine-web && diff "${TMPDIR:-/tmp}/spine-hashes-1.txt" web/dist/hashes.txt && echo "reproducible: $(wc -l < web/dist/hashes.txt) files, the same twice"; }
# The checks in a real browser (they need Google Chrome; set CHROME elsewhere than macOS): each native piece of the device, in Chrome and again in WebKit (what every browser on an
# iPhone runs; its build is fetched here, with the system libraries it needs where CI is set), and the whole app against a real server.
browser() { npm ci && npm run build && npm run check:browser -w spine-web && npx playwright-core install ${CI:+--with-deps} webkit && npm run check:webkit -w spine-web && npm run check:app -w spine-web; }
# The same three checks one at a time, so that CI runs them side by side (each builds what it needs): Chrome, WebKit and the whole app.
browser-chrome() { npm ci && npm run build && npm run check:browser -w spine-web; }
# In CI WebKit's system libraries are installed with apt (`--with-deps`), which took fourteen minutes once on a slow mirror; where the job runs in Playwright's own image
# (SPINE_BROWSER_IMAGE is set: .github/workflows/ci.yml) they and the browser are already there.
# Playwright's image has no compiler, and nothing the WebKit check runs needs better-sqlite3 (the server's native SQLite: the device uses WebAssembly), so there the install skips the packages' install scripts.
browser-webkit() { if [ -n "${SPINE_BROWSER_IMAGE:-}" ]; then npm ci --ignore-scripts; else npm ci; fi && npm run build && if [ -n "${CI:-}" ] && [ -z "${SPINE_BROWSER_IMAGE:-}" ]; then npx playwright-core install --with-deps webkit; else npx playwright-core install webkit; fi && npm run check:webkit -w spine-web; }
browser-app() { npm ci && npm run build && npm run check:app -w spine-web; }
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
    core/src packages/anaf/src packages/billing/src server/src web/src
}

case "${1:-all}" in
  server) server ;;
  web) web ;;
  browser) browser ;;
  browser-chrome) browser-chrome ;;
  browser-webkit) browser-webkit ;;
  browser-app) browser-app ;;
  repro) repro ;;
  scan) scan ;;
  scan-semgrep) scan_semgrep ;;
  all) server; web; scan ;;
  *) echo "usage: $0 [server|web|browser|browser-chrome|browser-webkit|browser-app|repro|scan|all]" >&2; exit 2 ;;
esac
