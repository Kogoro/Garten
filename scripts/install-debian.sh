#!/usr/bin/env bash
# Installs – or updates – Garten (Specs) natively on Debian 12/13 or Ubuntu 24.04: in a Proxmox LXC, a VM or a small server.
# Run as root. Safe to run again: it updates the code and keeps data and settings.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/scripts/install-debian.sh)"
#
# What you get
#   /opt/garten                the code (this repository), built
#   /var/lib/garten/data       SQLite database and one Git repository per team  ← back this up
#   /etc/garten/garten.env     settings (same variables as docker-compose.yml)
#   garten.service             the server, as the unprivileged user "garten", on 127.0.0.1:3000
#   Caddy                      HTTPS on port 443 with its own certificate authority (the offline mode of the app needs HTTPS);
#                              http://<address>/ explains how to trust that authority on a phone
#   garten                     command: garten info | update | url <address> | backup | logs
#
# Settings (environment variables, all optional)
#   GARTEN_URL     the address people will use.
#                    unset        first install: https://<IP of this machine> through Caddy; later runs keep what is set
#                    auto         detect the IP again and use https://<IP> through Caddy
#                    https://…    your own reverse proxy does TLS: no Caddy, Garten listens on port 3000 of all interfaces
#                    http://…     no TLS at all (port 3000). Works online only – browsers refuse offline mode without HTTPS.
#   GARTEN_ADMIN   e-mail address of the first admin (default admin@localhost; only used on an empty database)
#   GARTEN_REPO, GARTEN_REF   where the code comes from (default https://github.com/Kogoro/Garten.git, main)
set -euo pipefail

main() {
  local APP_DIR=/opt/garten HOME_DIR=/var/lib/garten DATA_DIR=/var/lib/garten/data ETC_DIR=/etc/garten WWW_DIR=/var/www/garten
  local ENVF=$ETC_DIR/garten.env CREDS=/root/garten.creds
  local REPO="${GARTEN_REPO:-https://github.com/Kogoro/Garten.git}" REF="${GARTEN_REF:-main}"
  local CA_SRC=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt

  step() { printf '\n==> %s\n' "$*"; }
  die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
  getenv() { [ -f "$ENVF" ] && sed -n "s/^$1=//p" "$ENVF" | tail -1 || true; }
  setenv() { local rest; rest=$(grep -v "^$1=" "$ENVF" || true); { [ -n "$rest" ] && printf '%s\n' "$rest"; printf '%s=%s\n' "$1" "$2"; } > "$ENVF.tmp"; chmod 600 "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; }
  unsetenv() { local rest; rest=$(grep -v "^$1=" "$ENVF" || true); printf '%s\n' "$rest" > "$ENVF.tmp"; chmod 600 "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; }

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
  if [ -z "$url" ] || [ "$url" = auto ]; then
    [ -n "$ip" ] || die "This machine has no IP address yet. Give it one, or pass GARTEN_URL=https://…"
    url="https://$ip"; mode=caddy
  elif [ -z "${GARTEN_URL:-}" ] && [ "$(getenv HOST)" = 127.0.0.1 ]; then
    mode=caddy                              # an update of an installation that already runs behind Caddy
  else
    case "$url" in https://*) mode=proxy ;; http://*) mode=plain ;; *) die "GARTEN_URL must start with https:// or http://" ;; esac
  fi
  url="${url%/}"
  local host="${url#*://}"; host="${host%%/*}"; host="${host%%:*}"

  # ---------------------------------------------------------------- user and directories
  id garten >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --shell /usr/sbin/nologin garten
  mkdir -p "$DATA_DIR" "$ETC_DIR" "$WWW_DIR"
  chown -R garten:garten "$HOME_DIR"
  chmod 750 "$HOME_DIR"

  # ---------------------------------------------------------------- code
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
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
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
    caddy) setenv HOST 127.0.0.1; setenv TRUST_PROXY 1 ;;
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
    echo "Garten    $(url)   ($(systemctl is-active garten))"
    [ -f /var/www/garten/garten-ca.crt ] && echo "Phone     http://$(hostname -I | awk '{print $1}')/   (install the certificate once, then offline mode works)"
    [ -f /root/garten.creds ] && echo "Login     see /root/garten.creds"
    echo "Data      /var/lib/garten/data      Settings  $ENVF"
    echo "Commands  garten update | url <https://…|auto> | backup | logs"
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
  systemctl daemon-reload
  systemctl enable --quiet garten
  systemctl restart garten
  local up=0
  for _ in $(seq 60); do curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3000/healthz 2>/dev/null && { up=1; break; }; sleep 1; done
  [ "$up" = 1 ] || { journalctl -u garten -n 30 --no-pager >&2 || true; die "Garten did not start – see the log above (journalctl -u garten)."; }

  if [ -n "$password" ]; then
    # The password was only needed to create the first admin; it does not stay in the settings file.
    unsetenv ADMIN_PASSWORD
    ( umask 077; printf 'Garten – first admin\n  Address:  %s\n  E-mail:   %s\n  Password: %s\nChange the password after the first sign-in (Account → Password), then delete this file.\n' "$url" "${GARTEN_ADMIN:-admin@localhost}" "$password" > "$CREDS" )
  fi

  # ---------------------------------------------------------------- HTTPS through Caddy
  if [ "$mode" = caddy ]; then
    step "Setting up HTTPS (Caddy)"
    command -v caddy >/dev/null || apt-get install -y -qq caddy >/dev/null
    local names="https://$host" hn; hn="$(hostname 2>/dev/null || true)"
    case "$hn" in ''|localhost|"$host") ;; *) names="$names, https://$hn" ;; esac
    cat > /etc/caddy/Caddyfile <<EOF
# Written by Garten's installer (scripts/install-debian.sh) – "garten url …" writes it again.
{
	auto_https disable_redirects
	skip_install_trust
}

# The app. Caddy signs the certificate with its own authority; devices trust it once (see http://$host/).
$names {
	tls internal
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}

# Plain HTTP: only the certificate and the page that explains how to install it.
:80 {
	root * $WWW_DIR
	@ca path /garten-ca.crt
	header @ca Content-Type application/x-x509-ca-cert
	file_server
}
EOF
    systemctl enable --quiet caddy
    systemctl restart caddy
    for _ in $(seq 30); do [ -s "$CA_SRC" ] && break; sleep 1; done
    [ -s "$CA_SRC" ] || die "Caddy did not create its certificate authority – see: journalctl -u caddy"
    install -m 644 "$CA_SRC" "$WWW_DIR/garten-ca.crt"
    cat > "$WWW_DIR/index.html" <<EOF
<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Garten – set up this device</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:1.5rem 1rem;color:#1c1c1c;background:#fafaf7}
@media(prefers-color-scheme:dark){body{color:#eee;background:#181816}a{color:#9ccf8f}}
h1{font-size:1.4rem}a.b{display:inline-block;padding:.7rem 1rem;border-radius:.6rem;background:#2f6f3e;color:#fff;text-decoration:none;margin:.3rem 0}
li{margin:.4rem 0}code{background:#8882;padding:.1rem .3rem;border-radius:.3rem}</style>
<h1>Garten – set up this device</h1>
<p>Garten runs at <a href="$url">$url</a>. Its certificate is signed by this server's own authority. Trust it once on each device – only then the browser allows the app to work <b>offline</b>.</p>
<p><a class="b" href="/garten-ca.crt" download>1 · Download the certificate</a></p>
<ol start="2">
<li><b>Android:</b> Settings → Security &amp; privacy → More security settings → Install from device storage → <i>CA certificate</i> → choose <code>garten-ca.crt</code>. (Search the settings for “CA certificate” if the menu differs.) Use Chrome.</li>
<li><b>iPhone / iPad:</b> open the download in Safari → <i>Allow</i> → Settings → <i>Profile Downloaded</i> → Install. Then Settings → General → About → Certificate Trust Settings → switch on “Caddy Local Authority”.</li>
<li><b>Desktop:</b> import the file as a trusted root authority in the browser (Firefox: Settings → Certificates → Authorities) or in the system.</li>
</ol>
<p><a class="b" href="$url">3 · Open Garten</a></p>
<p>Then sign in, choose “Add to Home Screen”, and open every team once while online.</p>
</html>
EOF
  elif systemctl is-enabled --quiet caddy 2>/dev/null && grep -q "Garten's installer" /etc/caddy/Caddyfile 2>/dev/null; then
    systemctl disable --quiet --now caddy       # switched from Caddy to another address
  fi

  # ---------------------------------------------------------------- done
  printf '\n✓ Garten is running:  %s\n' "$url"
  [ -n "$password" ] && printf '  Sign in as  %s  with the password in  %s\n' "${GARTEN_ADMIN:-admin@localhost}" "$CREDS"
  case "$mode" in
    caddy) printf '  Phone: open  http://%s/  once and install the certificate – without it the app shows a warning and cannot work offline.\n' "$host" ;;
    proxy) printf '  Point your reverse proxy at  http://%s:3000  (forward the Host header and X-Forwarded-*).\n' "${ip:-this machine}" ;;
    plain) printf '  No HTTPS: the app works online only (browsers allow offline mode only over HTTPS).\n' ;;
  esac
  printf '  More: garten info\n'
}

main "$@"
