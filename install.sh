#!/bin/bash

set -euo pipefail

SPINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPINE_USER="${SUDO_USER:-$(whoami)}"

NGINX_PKG_DIR="$(cd "${SPINE_DIR}/../packages/nginx" 2>/dev/null && pwd || true)"

function usage() {
  printf "Usage: $(basename $0) [OPTIONS]\n\n"
  printf "    -h      print this help\n"
  printf "    -d      install system dependencies\n"
  printf "    -b      build server + web app\n"
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

function build() {
  echo "Building web app..."
  cd "${SPINE_DIR}/web"
  npm ci
  npm run build

  echo "Building server..."
  cd "${SPINE_DIR}/server"
  npm ci
  npm run build

  echo "Setting up Python venv for ingestion service..."
  cd "${SPINE_DIR}/ingestion-service"
  # PYTHON=python3.13 ./install.sh -b if the default python3 is newer than the sidecar supports (3.11 to 3.13)
  "${PYTHON:-python3}" -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
  # --no-deps: its dependencies include torch and transformers (about 1 GB), and strategy="fast" uses neither. See requirements.txt.
  .venv/bin/pip install --no-deps unstructured_inference==1.6.13

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

  for unit in spine-web.service spine-ingestion.service spine-backup.service spine-backup.timer; do
    sed \
      -e "s|SPINE_DIR|${SPINE_DIR}|g" \
      -e "s|SPINE_USER|${SPINE_USER}|g" \
      "${SPINE_DIR}/systemd/${unit}" \
      > "/etc/systemd/system/${unit}"
    echo "  installed /etc/systemd/system/${unit}"
  done

  systemctl daemon-reload

  systemctl enable spine-ingestion spine-web
  systemctl restart spine-ingestion
  sleep 2
  systemctl restart spine-web

  # The timer is enabled and started; the service itself is oneshot and is only
  # run by the timer (or by hand: systemctl start spine-backup).
  systemctl enable --now spine-backup.timer

  echo ""
  echo "Services started."
  echo "  spine-ingestion: $(systemctl is-active spine-ingestion)"
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
  sed "s/SPINE_DOMAIN/${DOMAIN}/g" "${SPINE_DIR}/nginx/spine.conf" \
    | tee /etc/nginx/sites-available/spine > /dev/null
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
