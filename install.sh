#!/bin/bash

set -euo pipefail

SPINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPINE_USER="${SUDO_USER:-$(whoami)}"

NGINX_PKG_DIR="$(cd "${SPINE_DIR}/../packages/nginx" 2>/dev/null && pwd || true)"

function usage() {
  printf "Usage: $(basename $0) [OPTIONS]\n\n"
  printf "    -h      print this help\n"
  printf "    -d      install system dependencies\n"
  printf "    -b      build core + server + web app\n"
  printf "    -s      install and start systemd services\n"
  printf "    -n      set up nginx (cert + site config)\n"
  printf "\nFirst install:\n"
  printf "  sudo $(basename $0) -d -b -s -n\n"
  printf "\nRebuild after code changes:\n"
  printf "  $(basename $0) -b && sudo systemctl restart spine-web\n"
}

function install_deps() {
  echo "Installing system dependencies..."
  apt-get update
  apt-get install -y \
    curl ca-certificates \
    python3 python3-venv python3-pip \
    poppler-utils \
    tesseract-ocr tesseract-ocr-ron

  # Raspberry Pi OS ships an old Node; use NodeSource LTS if needed.
  # Accept 22 (maintenance), 24 (LTS), 26 (LTS from 2026-10-28). Node 20 is EOL.
  if ! node --version 2>/dev/null | grep -qE '^v(22|24|26)\.'; then
    echo "Installing Node.js LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
  fi
  echo "Node: $(node --version), npm: $(npm --version)"
}

# SECURITY.md S-32: a build with a known high or critical advisory in a runtime dependency stops.
# SPINE_SKIP_AUDIT=1 skips it (offline build); the advisory database needs the network.
function audit_dependencies() {
  if [[ "${SPINE_SKIP_AUDIT:-}" == "1" ]]; then
    echo "Skipping the dependency audit (SPINE_SKIP_AUDIT=1)"
    return
  fi
  echo "Auditing dependencies..."
  # One lockfile at the root covers core, server and web
  (cd "${SPINE_DIR}" && npm audit --omit=dev --audit-level=high) || {
    echo "ERROR: a dependency has a high or critical advisory (see above). Update it, or SPINE_SKIP_AUDIT=1 to build anyway." >&2
    exit 1
  }
}

function build() {
  # core, server and web are npm workspaces: one install, and core is built first because the other two use it
  echo "Installing dependencies and building (core, server, web app)..."
  cd "${SPINE_DIR}"
  npm ci
  npm run build

  audit_dependencies

  echo "Build complete."
}

# SECURITY.md P3: an unsafe configuration must be unreachable, not merely
# documented against. The server validates these at startup too; checking here
# as well means a bad .env fails at deploy time rather than leaving the unit in
# a restart loop.
function env_value() {
  grep -E "^${1}=" "${SPINE_DIR}/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

function check_secrets() {
  local problems=()

  local secret
  secret=$(env_value SESSION_SECRET)
  if [ -z "${secret}" ]; then
    problems+=("SESSION_SECRET is not set")
  elif [ "${#secret}" -lt 32 ]; then
    problems+=("SESSION_SECRET is ${#secret} chars; needs at least 32")
  elif [ "${secret}" = "change-this-to-a-random-64-char-string" ] \
    || [ "${secret}" = "dev-secret-change-in-production-must-be-32-chars" ]; then
    problems+=("SESSION_SECRET is a published placeholder")
  fi

  if [ ${#problems[@]} -gt 0 ]; then
    echo "ERROR: ${SPINE_DIR}/.env is not safe to deploy:"
    for problem in "${problems[@]}"; do
      echo "  - ${problem}"
    done
    echo ""
    echo "Generate a secret with: openssl rand -base64 48"
    exit 1
  fi
}

function install_services() {
  echo "Installing systemd services..."

  mkdir -p "${SPINE_DIR}/data"
  chown -R "${SPINE_USER}:${SPINE_USER}" "${SPINE_DIR}/data"

  # P11. Same medium as the archive, so this covers corruption and mistakes,
  # not a dead SD card — set SPINE_BACKUP_DIR to removable or network storage
  # and add it to ReadWritePaths in spine-backup.service for that.
  mkdir -p "${SPINE_DIR}/backups"
  chown -R "${SPINE_USER}:${SPINE_USER}" "${SPINE_DIR}/backups"

  if [ ! -f "${SPINE_DIR}/.env" ]; then
    echo "ERROR: ${SPINE_DIR}/.env not found. Copy .env.example and fill it in first."
    exit 1
  fi

  check_secrets

  for unit in spine-web.service spine-backup.service spine-backup.timer; do
    sed \
      -e "s|SPINE_DIR|${SPINE_DIR}|g" \
      -e "s|SPINE_USER|${SPINE_USER}|g" \
      "${SPINE_DIR}/systemd/${unit}" \
      > "/etc/systemd/system/${unit}"
    echo "  installed /etc/systemd/system/${unit}"
  done

  systemctl daemon-reload

  systemctl enable spine-web
  sleep 2
  systemctl restart spine-web

  # The timer is enabled and started; the service itself is oneshot and is only
  # run by the timer (or by hand: systemctl start spine-backup).
  systemctl enable --now spine-backup.timer

  echo ""
  echo "Services started."
  echo "  spine-web:       $(systemctl is-active spine-web)"
  echo "  spine-backup:    $(systemctl is-active spine-backup.timer) (timer)"

  # There is no default account and no signup: the first one is made here.
  local accounts
  accounts=$(cd "${SPINE_DIR}/server" && sudo -u "${SPINE_USER}" env DATA_DIR="${SPINE_DIR}/data" \
    node --env-file="${SPINE_DIR}/.env" dist/cli.js list-users 2>/dev/null || true)
  if [ -z "${accounts}" ] || [ "${accounts}" = "no accounts" ]; then
    echo ""
    echo "No accounts exist yet. Create the first one with:"
    echo "  cd ${SPINE_DIR}/server && DATA_DIR=${SPINE_DIR}/data npm run cli -- create-user you@example.com"
  fi
}

function setup_nginx() {
  if [ ! -f "${SPINE_DIR}/.env" ]; then
    echo "ERROR: ${SPINE_DIR}/.env not found."
    exit 1
  fi

  DOMAIN=$(grep -E '^SPINE_DOMAIN=' "${SPINE_DIR}/.env" | cut -d= -f2 | tr -d '"' | tr -d "'")
  if [ -z "${DOMAIN}" ]; then
    echo "ERROR: SPINE_DOMAIN not set in .env"
    exit 1
  fi

  echo "Setting up nginx for ${DOMAIN}..."

  # Use the nginx package script for cert issuance
  if [ -n "${NGINX_PKG_DIR}" ] && [ -f "${NGINX_PKG_DIR}/nginx-domains.sh" ]; then
    echo "Obtaining Let's Encrypt certificate via nginx package..."
    "${NGINX_PKG_DIR}/nginx-domains.sh" cert "${DOMAIN}"
  else
    echo "WARNING: packages/nginx not found at ${NGINX_PKG_DIR}"
    echo "Run manually: nginx-domains.sh cert ${DOMAIN}"
  fi

  # Install Spine's site config
  # SPINE_REPO_URL is optional: without it the /source, /docs and /security redirects are left out.
  REPO_URL=$(grep -E '^SPINE_REPO_URL=' "${SPINE_DIR}/.env" | cut -d= -f2 | tr -d '"' | tr -d "'" | sed 's|/*$||')
  # SPINE_RELAY_URL is the address the page may send model calls to (docs/relay.md); it goes into the page's content security policy.
  RELAY_URL=$(grep -E '^SPINE_RELAY_URL=' "${SPINE_DIR}/.env" | cut -d= -f2 | tr -d '"' | tr -d "'" | sed 's|/*$||')
  if [ -n "${REPO_URL}" ]; then
    sed -e "s|SPINE_REPO_URL|${REPO_URL}|g" -e "s|SPINE_RELAY_URL|${RELAY_URL}|g" -e "s/SPINE_DOMAIN/${DOMAIN}/g" "${SPINE_DIR}/nginx/spine.conf"
  else
    echo "SPINE_REPO_URL not set: no /source, /docs or /security redirects."
    sed -e '/SPINE_REPO_URL/d' -e "s|SPINE_RELAY_URL|${RELAY_URL}|g" -e "s/SPINE_DOMAIN/${DOMAIN}/g" "${SPINE_DIR}/nginx/spine.conf"
  fi | tee /etc/nginx/sites-available/spine > /dev/null

  # security.txt (RFC 9116) expires after a year; running -n again renews it.
  mkdir -p /var/www/spine
  EXPIRES=$(date -u -d '+1 year' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1y +%Y-%m-%dT%H:%M:%SZ)
  sed -e "s/SPINE_DOMAIN/${DOMAIN}/g" -e "s/SPINE_EXPIRES/${EXPIRES}/g" "${SPINE_DIR}/nginx/security.txt" \
    > /var/www/spine/security.txt
  ln -sf /etc/nginx/sites-available/spine /etc/nginx/sites-enabled/spine

  nginx -t && systemctl reload nginx
  echo "nginx configured for ${DOMAIN}."
}

if [ $# -eq 0 ]; then
  usage
  exit 0
fi

while getopts "hdbsn" arg; do
  case ${arg} in
    h) usage; exit 0 ;;
    d) install_deps ;;
    b) build ;;
    s) install_services ;;
    n) setup_nginx ;;
    ?) echo "Invalid option: -${OPTARG}"; usage; exit 1 ;;
  esac
done
