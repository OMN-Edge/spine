#!/bin/bash

set -euo pipefail

SPINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPINE_USER="${SUDO_USER:-$(whoami)}"

NGINX_PKG_DIR="$(cd "${SPINE_DIR}/../packages/nginx" 2>/dev/null && pwd || true)"

function usage() {
  printf "Usage: $(basename $0) [OPTIONS]\n\n"
  printf "    -h      print this help\n"
  printf "    -a      all of it, in order: -d -e -b -s, -r when relay.env exists, -n\n"
  printf "    -d      install system dependencies\n"
  printf "    -e      write .env (and relay.env, given a provider key) with generated secrets; an existing file is left alone\n"
  printf "    -b      build core + server + web app\n"
  printf "    -s      install and start systemd services\n"
  printf "    -r      install and start the relay for model calls on this machine (needs relay.env)\n"
  printf "    -n      set up nginx (certificates + site config, the relay's too when SPINE_RELAY_DOMAIN is set)\n"
  printf "\nFirst install, in one line (asks for what it is not given):\n"
  printf "  sudo SPINE_DOMAIN=spine.example.com ANTHROPIC_API_KEY=sk-ant-... $(basename $0) -a\n"
  printf "\nRebuild after code changes:\n"
  printf "  $(basename $0) -b && sudo systemctl restart spine-web\n"
  printf "\nOptional for -e and -a: SPINE_RELAY_DOMAIN (default relay.<domain>); for -n: SPINE_CERT_EMAIL (Let's Encrypt's notices)\n"
}

function require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: -$1 needs root: sudo $(basename "$0") -$1" >&2
    exit 1
  fi
}

# npm and the files it writes belong to the person who ran sudo, not to root, so a later `./install.sh -b` without sudo still works.
function as_user() {
  if [ "$(id -u)" -eq 0 ] && [ "${SPINE_USER}" != "root" ]; then
    sudo -u "${SPINE_USER}" -H "$@"
  else
    "$@"
  fi
}

function install_deps() {
  echo "Installing system dependencies..."
  apt-get update
  apt-get install -y \
    curl ca-certificates \
    python3   # node-gyp compiles better-sqlite3 where no prebuilt binary fits; nothing else needs it (no parser, no OCR: the device does both)

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
  (cd "${SPINE_DIR}" && as_user npm audit --omit=dev --audit-level=high) || {
    echo "ERROR: a dependency has a high or critical advisory (see above). Update it, or SPINE_SKIP_AUDIT=1 to build anyway." >&2
    exit 1
  }
}

function build() {
  # core, server and web are npm workspaces: one install, and core is built first because the other two use it
  echo "Installing dependencies and building (core, server, web app)..."
  cd "${SPINE_DIR}"
  as_user npm ci
  as_user npm run build

  audit_dependencies

  echo "Build complete."
}

# SECURITY.md P3: an unsafe configuration must be unreachable, not merely
# documented against. The server validates these at startup too; checking here
# as well means a bad .env fails at deploy time rather than leaving the unit in
# a restart loop.
function env_value() {
  local file="${2:-${SPINE_DIR}/.env}"
  { grep -E "^${1}=" "${file}" || true; } | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

# Sets KEY=VALUE in a file: replaces the line that sets it, or the first commented-out example of it, or adds it at the end.
# awk and a rename rather than `sed -i`, so -e also works on a Mac (for Docker Compose).
function set_env() {
  local file="$1" key="$2" value="$3"
  awk -v k="${key}" -v v="${value}" '
    !done && ($0 ~ "^" k "=" || $0 ~ "^# *" k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "${file}" > "${file}.tmp"
  cat "${file}.tmp" > "${file}"
  rm -f "${file}.tmp"
}

# 32 random bytes as hex: no character that needs quoting in a .env, a systemd unit or sed
function random_secret() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Asks on the terminal, when there is one; prints the answer (empty when there is no terminal or no answer)
function ask() {
  local answer=""
  if [ -t 0 ]; then
    if [ "${2:-}" = "secret" ]; then
      read -r -s -p "$1: " answer
      echo >&2
    else
      read -r -p "$1: " answer
    fi
  fi
  printf '%s' "${answer}"
}

function make_env() {
  local env="${SPINE_DIR}/.env" relay="${SPINE_DIR}/relay.env"
  if [ -f "${env}" ]; then
    echo "${env} exists: leaving it as it is."
    return
  fi

  local domain="${SPINE_DOMAIN:-}"
  [ -n "${domain}" ] || domain=$(ask "Domain Spine will be served from (e.g. spine.example.com)")
  if [ -z "${domain}" ]; then
    echo "ERROR: a domain is needed: SPINE_DOMAIN=spine.example.com $(basename "$0") -e" >&2
    exit 1
  fi

  # The relay on this machine needs the provider's key; without one the relay is left out (it can run elsewhere: docs/relay.md)
  local key="${ANTHROPIC_API_KEY:-}"
  if [ -z "${key}" ] && [ ! -f "${relay}" ]; then
    key=$(ask "Anthropic API key for a relay on this machine (Enter for none)" secret)
  fi

  echo "Writing ${env}..."
  (umask 077 && cp "${SPINE_DIR}/.env.example" "${env}")
  set_env "${env}" SESSION_SECRET "$(random_secret)"
  set_env "${env}" SPINE_DOMAIN "${domain}"
  set_env "${env}" SPINE_RELAY_SECRET "$(random_secret)"
  # The server holds no model credential: comment out the example's placeholder
  awk '/^ANTHROPIC_API_KEY=sk-ant-\.\.\.$/ { print "# " $0 " (the relay holds it: relay.env)"; next } { print }' "${env}" > "${env}.tmp"
  cat "${env}.tmp" > "${env}" && rm -f "${env}.tmp"

  if [ -n "${key}" ] || [ -f "${relay}" ]; then
    local relay_domain="${SPINE_RELAY_DOMAIN:-relay.${domain}}"
    set_env "${env}" SPINE_RELAY_DOMAIN "${relay_domain}"
    set_env "${env}" SPINE_RELAY_URL "https://${relay_domain}"
    # Docker Compose starts its relay service with this; the systemd install ignores it
    set_env "${env}" COMPOSE_PROFILES relay
    if [ ! -f "${relay}" ]; then
      echo "Writing ${relay}..."
      (umask 077 && cp "${SPINE_DIR}/relay.env.example" "${relay}")
      set_env "${relay}" ANTHROPIC_API_KEY "${key}"
    fi
    echo "The relay will answer at https://${relay_domain}: point that name's DNS at this machine too."
  else
    echo "No relay on this machine: set SPINE_RELAY_URL in .env to one elsewhere (docs/relay.md), or devices cannot call a model."
  fi

  if [ "$(id -u)" -eq 0 ] && [ "${SPINE_USER}" != "root" ]; then
    chown "${SPINE_USER}:" "${env}"
    [ ! -f "${relay}" ] || chown "${SPINE_USER}:" "${relay}"
  fi
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
    echo "ERROR: ${SPINE_DIR}/.env not found. Copy .env.example and fill it in first, or run $(basename "$0") -e."
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

# The relay for model calls, beside the server (docs/relay.md). It reads .env for what it shares with the server and relay.env for the
# provider's credential; it listens on loopback and nginx gives it its own hostname (-n).
function install_relay() {
  local env="${SPINE_DIR}/.env" relay="${SPINE_DIR}/relay.env"
  if [ ! -f "${env}" ]; then
    echo "ERROR: ${env} not found. Run $(basename "$0") -e first." >&2
    exit 1
  fi
  if [ ! -f "${relay}" ]; then
    echo "ERROR: ${relay} not found. cp relay.env.example relay.env and put the provider's key in it (docs/relay.md)." >&2
    exit 1
  fi

  local problems=()
  local domain relay_domain relay_url relay_secret provider key
  domain=$(env_value SPINE_DOMAIN)
  relay_domain=$(env_value SPINE_RELAY_DOMAIN)
  relay_url=$(env_value SPINE_RELAY_URL | sed 's|/*$||')
  relay_secret=$(env_value SPINE_RELAY_SECRET)
  provider=$(env_value SPINE_LLM_PROVIDER "${relay}")
  key=$(env_value ANTHROPIC_API_KEY "${relay}")
  [ -n "${domain}" ] || problems+=("SPINE_DOMAIN is not set in .env (the only origin the relay answers)")
  [ -n "${relay_domain}" ] || problems+=("SPINE_RELAY_DOMAIN is not set in .env (the relay's own hostname, e.g. relay.${domain:-spine.example.com})")
  if [ -n "${relay_domain}" ] && [ "${relay_url}" != "https://${relay_domain}" ]; then
    problems+=("SPINE_RELAY_URL in .env is '${relay_url}', not https://${relay_domain}: devices would call another relay")
  fi
  [ "${#relay_secret}" -ge 32 ] || problems+=("SPINE_RELAY_SECRET in .env needs at least 32 characters")
  if [ "${provider:-anthropic}" = "anthropic" ] && { [ -z "${key}" ] || [ "${key}" = "sk-ant-..." ]; }; then
    problems+=("ANTHROPIC_API_KEY in relay.env is not set")
  fi
  if [ ${#problems[@]} -gt 0 ]; then
    echo "ERROR: the relay is not ready to start:"
    for problem in "${problems[@]}"; do
      echo "  - ${problem}"
    done
    exit 1
  fi

  echo "Installing the relay..."
  mkdir -p "${SPINE_DIR}/relay-data"
  chown -R "${SPINE_USER}:${SPINE_USER}" "${SPINE_DIR}/relay-data"
  sed \
    -e "s|SPINE_DIR|${SPINE_DIR}|g" \
    -e "s|SPINE_USER|${SPINE_USER}|g" \
    -e "s|SPINE_DOMAIN|${domain}|g" \
    "${SPINE_DIR}/systemd/spine-relay.service" \
    > /etc/systemd/system/spine-relay.service
  echo "  installed /etc/systemd/system/spine-relay.service"

  systemctl daemon-reload
  systemctl enable spine-relay
  systemctl restart spine-relay

  local up=""
  for _ in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then up=1; break; fi
    sleep 0.5
  done
  if [ -z "${up}" ]; then
    echo "ERROR: the relay did not start. See: journalctl -u spine-relay -n 30" >&2
    exit 1
  fi
  echo "  spine-relay:     $(systemctl is-active spine-relay) (127.0.0.1:8080; public at https://${relay_domain} once -n has run)"
}

# A certificate for one name: kept if it exists, else from the nginx package when it is there, else from certbot on its own
function obtain_cert() {
  local domain="$1"
  if [ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" ]; then
    echo "A certificate for ${domain} exists."
    return
  fi
  if [ -n "${NGINX_PKG_DIR}" ] && [ -f "${NGINX_PKG_DIR}/nginx-domains.sh" ]; then
    echo "Obtaining a Let's Encrypt certificate for ${domain} via the nginx package..."
    "${NGINX_PKG_DIR}/nginx-domains.sh" cert "${domain}"
    return
  fi
  command -v certbot >/dev/null || apt-get install -y certbot
  echo "Obtaining a Let's Encrypt certificate for ${domain} with certbot..."
  local contact=(--register-unsafely-without-email)
  [ -z "${SPINE_CERT_EMAIL:-}" ] || contact=(-m "${SPINE_CERT_EMAIL}")
  # Standalone, with nginx stopped for the minute it takes: the site config cannot load before its certificate exists
  certbot certonly --standalone --non-interactive --agree-tos "${contact[@]}" -d "${domain}" \
    --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
}

function setup_nginx() {
  if [ ! -f "${SPINE_DIR}/.env" ]; then
    echo "ERROR: ${SPINE_DIR}/.env not found."
    exit 1
  fi

  DOMAIN=$(env_value SPINE_DOMAIN)
  if [ -z "${DOMAIN}" ]; then
    echo "ERROR: SPINE_DOMAIN not set in .env"
    exit 1
  fi
  RELAY_DOMAIN=$(env_value SPINE_RELAY_DOMAIN)

  echo "Setting up nginx for ${DOMAIN}${RELAY_DOMAIN:+ and ${RELAY_DOMAIN}}..."

  # Without the nginx package, the distribution's nginx. Its nginx.conf has no `main` log format, which the site configs name.
  if [ -z "${NGINX_PKG_DIR}" ]; then
    command -v nginx >/dev/null || apt-get install -y nginx
    if ! grep -rqsE '^\s*log_format\s+main\b' /etc/nginx; then
      echo "log_format main '\$remote_addr - \$remote_user [\$time_local] \"\$request\" \$status \$body_bytes_sent \"\$http_referer\" \"\$http_user_agent\"';" \
        > /etc/nginx/conf.d/spine-log-format.conf
    fi
  fi

  obtain_cert "${DOMAIN}"
  [ -z "${RELAY_DOMAIN}" ] || obtain_cert "${RELAY_DOMAIN}"

  # Install Spine's site config
  # SPINE_REPO_URL is optional: without it the /source, /docs and /security redirects are left out.
  REPO_URL=$(env_value SPINE_REPO_URL | sed 's|/*$||')
  # SPINE_RELAY_URL is the address the page may send model calls to (docs/relay.md); it goes into the page's content security policy.
  RELAY_URL=$(env_value SPINE_RELAY_URL | sed 's|/*$||')
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

  # The relay's site, when it runs here; removed when SPINE_RELAY_DOMAIN is no longer set
  if [ -n "${RELAY_DOMAIN}" ]; then
    sed -e "s/SPINE_RELAY_DOMAIN/${RELAY_DOMAIN}/g" "${SPINE_DIR}/nginx/spine-relay.conf" > /etc/nginx/sites-available/spine-relay
    ln -sf /etc/nginx/sites-available/spine-relay /etc/nginx/sites-enabled/spine-relay
  else
    rm -f /etc/nginx/sites-enabled/spine-relay
  fi

  nginx -t
  if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl start nginx; fi
  echo "nginx configured for ${DOMAIN}${RELAY_DOMAIN:+ and ${RELAY_DOMAIN}}."
}

function install_all() {
  require_root a
  install_deps
  make_env
  build
  install_services
  if [ -f "${SPINE_DIR}/relay.env" ]; then install_relay; else echo "No relay.env: the relay is not installed here."; fi
  setup_nginx
  echo ""
  echo "Spine is at https://$(env_value SPINE_DOMAIN)"
}

if [ $# -eq 0 ]; then
  usage
  exit 0
fi

while getopts "hadebsrn" arg; do
  case ${arg} in
    h) usage; exit 0 ;;
    a) install_all ;;
    d) require_root d; install_deps ;;
    e) make_env ;;
    b) build ;;
    s) require_root s; install_services ;;
    r) require_root r; install_relay ;;
    n) require_root n; setup_nginx ;;
    ?) echo "Invalid option: -${OPTARG}"; usage; exit 1 ;;
  esac
done
