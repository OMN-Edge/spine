#!/usr/bin/env bash
# What a running host looks like, for the security review's pass 11b (docs/security-review.md): on the host, ./scripts/host-report.sh > report.txt; from another machine, ./scripts/host-report.sh outside spine.example.com relay.example.com
# For a Linux host with systemd and the units install.sh makes (spine-web, spine-relay, spine-backup); GNU stat and ss are used.
# Reads only: it changes nothing, prints no value from .env or relay.env (only their modes) and blanks email addresses. The restore drill works on a copy in a temporary directory.
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

section() { printf '\n===== %s =====\n' "$1"; }
run()     { printf '$ %s\n' "$*"; "$@" 2>&1 | sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g'; }
sh_run()  { printf '$ %s\n' "$1"; bash -c "$1" 2>&1 | sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g'; }

outside() {
  [ "$#" -gt 0 ] || { echo "usage: $0 outside <host>..." >&2; exit 1; }
  for h in "$@"; do
    section "TLS and headers: $h"
    for v in tls1 tls1_1 tls1_2 tls1_3; do
      printf '%s: ' "$v"
      openssl s_client -connect "$h:443" -servername "$h" "-$v" </dev/null 2>&1 | grep -E 'Cipher is|alert|error|unknown option' | head -1 || true
    done
    sh_run "curl -sI --max-time 15 https://$h | grep -i -E '^HTTP|strict-transport|content-security|x-content-type|referrer|x-frame|permissions-policy|^server'"
    sh_run "curl -sI --max-time 15 http://$h | grep -i -E '^HTTP|^location'"
  done
}

inside() {
  env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'"; }
  data="$(env_value DATA_DIR)"; [ -n "$data" ] || data="$PWD/data"
  bk="$(env_value SPINE_BACKUP_DIR)"; [ -n "$bk" ] || echo "SPINE_BACKUP_DIR is not set in .env: the backup sections are skipped"
  section "when and what"
  run date -u; run git rev-parse --short HEAD; run git branch --show-current; run uname -a

  section "modes and owners (S-61)"
  run stat -c '%a %U:%G %n' . "$data" "$data"/* .env relay.env
  if [ -n "$bk" ]; then echo "backup dir: $bk"; sh_run "stat -c '%a %U:%G %n' '$bk' '$bk'/* | head -30"; fi

  section "anything in the data and backup folders that others could read (none expected)"
  sh_run "find '$data' ${bk:+'$bk'} -perm /077 2>/dev/null | head -20; echo \"(\$(find '$data' ${bk:+'$bk'} -perm /077 2>/dev/null | wc -l) found)\""

  section "listening ports and firewall"
  sh_run "ss -tln"
  sh_run "sudo -n ufw status verbose || echo 'ufw: not available without a password'"
  sh_run "sudo -n iptables -S 2>&1 | head -30"

  sh_run "sudo -n ss -tlnp 2>&1 | awk '{print \$1, \$4, \$6}' | head -20"
  sh_run "sudo -n sshd -T 2>&1 | grep -E 'passwordauthentication|permitrootlogin|pubkeyauthentication|^port '"

  section "who runs what on the machine (the other applications beside this one)"
  sh_run "ps -eo user:20,comm --no-headers | sort | uniq -c | sort -rn | head -15"
  sh_run "free -h"

  section "the services as systemd runs them"
  sh_run "systemctl show spine-web spine-relay spine-backup -p Id,User,UMask,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,MemoryMax,RequiresMountsFor,Restart"
  sh_run "systemctl is-active spine-web spine-relay nginx"
  sh_run "systemctl list-timers 'spine*' --no-pager"
  sh_run "journalctl -u spine-backup -n 25 --no-pager"

  section "space and the mount"
  sh_run "df -h '$data' ${bk:+'$bk'} /"
  sh_run "findmnt \"\$(df --output=target '$data' | tail -1)\""

  section "the backup: contents, the trash folder, the country file"
  if [ -n "$bk" ]; then sh_run "ls -la '$bk' | head -30"; sh_run "ls -la '$bk'/vault-removed 2>&1 | head -20"; fi
  sh_run "ls -la '$data'/geoip/ 2>&1"

  section "restore drill (on a copy)"
  snap=""; [ -z "$bk" ] || snap="$(ls -t "$bk"/*.db "$bk"/*.sqlite "$bk"/*/*.db 2>/dev/null | head -1 || true)"
  if [ -z "$snap" ]; then echo "no snapshot found (backup dir: ${bk:-not set}; looked for *.db, *.sqlite)"; else
    work="$(mktemp -d)"; cp "$snap" "$work/snap.db"
    echo "newest snapshot: $snap ($(stat -c '%y' "$snap"))"
    if command -v sqlite3 >/dev/null; then
      sh_run "sqlite3 '$work/snap.db' 'pragma integrity_check; select count(*) as users from users;'"
    else
      # No sqlite3 on the host: the driver the server itself uses, from the repository
      sh_run "node -e \"const D=require('better-sqlite3'); const db=new D('$work/snap.db',{readonly:true}); console.log(db.pragma('integrity_check',{simple:true}), db.prepare('select count(*) as n from users').get().n+' users')\""
    fi
    rm -rf "$work"
  fi

  section "the accounts"
  sh_run "cd server && npm run --silent cli -- legacy; echo exit \$?"
  sh_run "cd server && npm run --silent cli -- list-users | wc -l"

  section "nginx"
  sh_run "sudo -n nginx -T 2>&1 | grep -E 'server_name|ssl_protocols|ssl_ciphers|listen|add_header|proxy_pass|password is required' | head -60"
}

case "${1:-inside}" in
  outside) shift; outside "$@" ;;
  inside)  inside ;;
  *) echo "usage: $0 [inside | outside <host>...]" >&2; exit 1 ;;
esac
