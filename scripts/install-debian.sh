#!/usr/bin/env bash
# Installs – or updates – Garten (Specs) natively on Debian 12/13 or Ubuntu 24.04: in a VM, an LXC container or a small server.
# Run as root. Safe to run again: it moves to the latest GitHub release and keeps data and settings.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/scripts/install-debian.sh)"
#
# What you get
#   /opt/garten                the code (this repository), built
#   /var/lib/garten/data       SQLite database and one Git repository per team  ← back this up
#   /etc/garten/garten.env     settings (same variables as docker-compose.yml)
#   garten.service             the server, as the unprivileged user "garten", on port 3000 (all interfaces)
#   garten                     command: garten info | update | url <address> | backup | logs
#
# Settings (environment variables, all optional)
#   GARTEN_URL     the address people will use.
#                    unset        first install: http://<IP of this machine>:3000; later runs keep what is set
#                    auto         detect the IP again and use http://<IP>:3000
#                    http://…     no TLS (port 3000). Works online only – browsers refuse offline mode without HTTPS.
#                    https://…    your own reverse proxy does TLS and forwards to port 3000
#   GARTEN_ADMIN   e-mail address of the first admin (default admin@localhost; only used on an empty database)
#   GARTEN_REPO    where the code comes from (default https://github.com/Kogoro/Garten.git)
#   GARTEN_REF     a tag or branch to install instead of the latest release (e.g. v0.11.0, or main for the development state)
set -euo pipefail

main() {
  local APP_DIR=/opt/garten HOME_DIR=/var/lib/garten DATA_DIR=/var/lib/garten/data ETC_DIR=/etc/garten
  local ENVF=$ETC_DIR/garten.env CREDS=/root/garten.creds
  local REPO="${GARTEN_REPO:-https://github.com/Kogoro/Garten.git}" REF="${GARTEN_REF:-}"

  step() { printf '\n==> %s\n' "$*"; }
  die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
  getenv() { [ -f "$ENVF" ] && sed -n "s/^$1=//p" "$ENVF" | tail -1 || true; }
  setenv() { local rest; rest=$(grep -v "^$1=" "$ENVF" || true); { [ -n "$rest" ] && printf '%s\n' "$rest"; printf '%s=%s\n' "$1" "$2"; } > "$ENVF.tmp"; chmod 600 "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; }
  unsetenv() { local rest; rest=$(grep -v "^$1=" "$ENVF" || true); printf '%s\n' "$rest" > "$ENVF.tmp"; chmod 600 "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; }

  # The newest published release of the repository: GitHub redirects /releases/latest to /releases/tag/<tag>.
  latest_release() {
    local base="${REPO%.git}" loc
    loc="$(curl -fsSIL --max-time 20 -o /dev/null -w '%{url_effective}' "$base/releases/latest" 2>/dev/null)" || return 1
    case "$loc" in */releases/tag/*) printf '%s\n' "${loc##*/}" ;; *) return 1 ;; esac
  }

  [ "$(id -u)" = 0 ] || die "Run this as root."
  command -v apt-get >/dev/null || die "This installer needs Debian or Ubuntu (apt-get)."
  command -v systemctl >/dev/null || die "This installer needs systemd."
  export DEBIAN_FRONTEND=noninteractive

  local first=1; [ -f "$ENVF" ] && first=0

  # ---------------------------------------------------------------- packages
  step "Installing packages"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git openssh-client gnupg >/dev/null

  node_ok() { command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; }
  if ! node_ok; then
    step "Installing Node.js 24"
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
    node_ok || die "Node.js 22.13 or newer is required, found: $(node --version 2>/dev/null || echo none)"
  fi

  # ---------------------------------------------------------------- address
  local ip url mode
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  url="${GARTEN_URL:-}"
  [ -z "$url" ] && [ "$first" = 0 ] && url="$(getenv PUBLIC_URL)"
  # An installation made by an older version of this script ran behind Caddy (HTTPS on 443, server on 127.0.0.1 only).
  # Caddy is gone, so unless an address was given, move it to plain HTTP.
  [ -z "${GARTEN_URL:-}" ] && [ "$first" = 0 ] && [ "$(getenv HOST)" = 127.0.0.1 ] && url=auto
  if [ -z "$url" ] || [ "$url" = auto ]; then
    [ -n "$ip" ] || die "This machine has no IP address yet. Give it one, or pass GARTEN_URL=http://…"
    url="http://$ip:3000"
  fi
  case "$url" in https://*) mode=proxy ;; http://*) mode=plain ;; *) die "GARTEN_URL must start with https:// or http://" ;; esac
  url="${url%/}"

  # ---------------------------------------------------------------- user and directories
  id garten >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --shell /usr/sbin/nologin garten
  mkdir -p "$DATA_DIR" "$ETC_DIR"
  chown -R garten:garten "$HOME_DIR"
  chmod 750 "$HOME_DIR"

  # ---------------------------------------------------------------- code
  if [ -z "$REF" ]; then
    REF="$(latest_release)" || die "Could not find a published release of $REPO. Publish one, or install a branch or tag explicitly: GARTEN_REF=main"
  fi
  step "Fetching Garten ($REF)"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" remote set-url origin "$REPO"
    git -C "$APP_DIR" fetch --quiet --depth 1 origin "$REF"
    git -C "$APP_DIR" reset --quiet --hard FETCH_HEAD
  else
    rm -rf "$APP_DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$APP_DIR"
  fi

  step "Building (takes a few minutes)"
  systemctl stop garten 2>/dev/null || true
  cd "$APP_DIR"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error   # the server needs no build scripts
  npm --prefix web ci --no-audit --no-fund --loglevel=error
  npm --prefix web run build >/dev/null
  rm -rf web/node_modules                    # only needed for the build
  [ -f web/dist/index.html ] || die "The build produced no web/dist/index.html."

  # ---------------------------------------------------------------- settings
  local password=""
  if [ "$first" = 1 ]; then
    password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
    ( umask 077; cat > "$ENVF" <<EOF
# Garten settings – the same variables as in docker-compose.yml. Apply changes with: systemctl restart garten
NODE_ENV=production
NODE_NO_WARNINGS=1
PORT=3000
DATA_DIR=$DATA_DIR
SEED_DEMO=0
ADMIN_EMAIL=${GARTEN_ADMIN:-admin@localhost}
ADMIN_PASSWORD=$password
EOF
    )
  fi
  setenv PUBLIC_URL "$url"
  case "$mode" in
    proxy) unsetenv HOST; setenv TRUST_PROXY 1 ;;
    plain) unsetenv HOST; setenv TRUST_PROXY 0 ;;
  esac

  # ---------------------------------------------------------------- service
  cat > /etc/systemd/system/garten.service <<EOF
[Unit]
Description=Garten (Specs) – specifications for AI agents
After=network-online.target
Wants=network-online.target

[Service]
User=garten
Group=garten
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENVF
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

  install -m 755 /dev/stdin /usr/local/bin/garten <<'EOF'
#!/usr/bin/env bash
# Helper for the Garten installation on this machine.
set -euo pipefail
ENVF=/etc/garten/garten.env
url() { sed -n 's/^PUBLIC_URL=//p' "$ENVF" | tail -1; }
case "${1:-info}" in
  info)
    echo "Garten    $(url)   ($(systemctl is-active garten))   version $(node -p "require('/opt/garten/package.json').version" 2>/dev/null || echo ?)"
    [ -f /root/garten.creds ] && echo "Login     see /root/garten.creds"
    echo "Data      /var/lib/garten/data      Settings  $ENVF"
    echo "Commands  garten update (latest release) | url <https://…|auto> | backup | logs"
    ;;
  update) exec bash /opt/garten/scripts/install-debian.sh ;;
  url) [ -n "${2:-}" ] || { echo "Usage: garten url <https://address | auto>" >&2; exit 1; }; GARTEN_URL="$2" exec bash /opt/garten/scripts/install-debian.sh ;;
  backup)
    out="/root/garten-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    systemctl stop garten; trap 'systemctl start garten' EXIT
    ( umask 077; tar czf "$out" -C /var/lib/garten data -C /etc/garten garten.env )
    echo "Saved $out  (restore: stop garten, unpack data/ into /var/lib/garten, chown -R garten:garten, start garten)"
    ;;
  logs) exec journalctl -u garten -n "${2:-100}" --no-pager ;;
  *) echo "Usage: garten [info|update|url <address>|backup|logs]" >&2; exit 1 ;;
esac
EOF

  step "Starting Garten"
  # File-system sandbox: read-only system, private /tmp, no /home. It needs mount namespaces, which some containers do not allow –
  # it is a drop-in, so it can be taken away again if the service does not start with it.
  local SANDBOX=/etc/systemd/system/garten.service.d/sandbox.conf
  mkdir -p "$(dirname "$SANDBOX")"
  printf '[Service]\nProtectSystem=strict\nReadWritePaths=%s\nProtectHome=true\nPrivateTmp=true\n' "$HOME_DIR" > "$SANDBOX"
  systemctl daemon-reload
  systemctl enable --quiet garten
  systemctl restart garten || true
  wait_up() { local i; for i in $(seq 60); do curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3000/healthz 2>/dev/null && return 0; sleep 1; done; return 1; }
  local up=0
  wait_up && up=1
  if [ "$up" = 0 ] && [ -f "$SANDBOX" ]; then
    printf '\n! Garten did not start with the file-system sandbox (this container may not allow it) – trying again without it.\n' >&2
    rm -f "$SANDBOX"; systemctl daemon-reload; systemctl restart garten || true
    wait_up && up=1
  fi
  [ "$up" = 1 ] || { journalctl -u garten -n 30 --no-pager >&2 || true; die "Garten did not start – see the log above (journalctl -u garten)."; }

  if [ -n "$password" ]; then
    # The password was only needed to create the first admin; it does not stay in the settings file.
    unsetenv ADMIN_PASSWORD
    ( umask 077; printf 'Garten – first admin\n  Address:  %s\n  E-mail:   %s\n  Password: %s\nChange the password after the first sign-in (Account → Password), then delete this file.\n' "$url" "${GARTEN_ADMIN:-admin@localhost}" "$password" > "$CREDS" )
  fi

  # Older versions of this script put Caddy in front of Garten; it is not used any more.
  if grep -qs "Garten's installer" /etc/caddy/Caddyfile; then
    systemctl disable --quiet --now caddy 2>/dev/null || true
    rm -rf /var/www/garten
  fi

  # ---------------------------------------------------------------- done
  printf '\n✓ Garten is running:  %s\n' "$url"
  [ -n "$password" ] && printf '  Sign in as  %s  with the password in  %s\n' "${GARTEN_ADMIN:-admin@localhost}" "$CREDS"
  case "$mode" in
    proxy) printf '  Point your reverse proxy at  http://%s:3000  (forward the Host header and X-Forwarded-*).\n' "${ip:-this machine}" ;;
    plain) printf '  No HTTPS: the app works online only (browsers allow offline mode only over HTTPS).\n' ;;
  esac
  printf '  More: garten info\n'
}

main "$@"
