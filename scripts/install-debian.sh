#!/usr/bin/env bash
# Installs – or updates – Garten (Specs) natively on Debian 12/13 or Ubuntu 24.04: in a VM, an LXC container or a small server.
# Run as root. Safe to run again: it moves to the latest GitHub release and keeps data and settings.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/scripts/install-debian.sh)"
#
# What you get
#   /opt/garten                the code: the prebuilt release archive, or this repository built here (branches, or no archive)
#   /opt/garten.old            the version before the last update (kept for a manual rollback)
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
#
# How an update works
#   The new version is put together in /opt/garten.new while the old one keeps running: release archive (checked against its
#   sha256 file) or a build from source, then the server's npm dependencies. Only when that is complete is the service stopped
#   and the directories swapped. If the new version does not answer on /healthz, the old one is moved back and started again.
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

  # One run at a time: two updates at once would build into the same directory and swap each other's code.
  exec 9>/run/garten-install.lock
  flock -n 9 || die "Another install or update of Garten is running."

  # ---------------------------------------------------------------- code
  # Everything here happens next to the running installation, in $NEW_DIR; the service keeps running until the swap below.
  # NEW_DIR and WORK_DIR are global (not local) so the exit trap can still clean them up when a step fails.
  NEW_DIR=$APP_DIR.new
  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR" "$NEW_DIR"' EXIT
  rm -rf "$NEW_DIR"; mkdir -p "$NEW_DIR"

  if [ -z "$REF" ]; then
    REF="$(latest_release)" || die "Could not find a published release of $REPO. Publish one, or install a branch or tag explicitly: GARTEN_REF=main"
  fi

  # A release has a prebuilt archive (web app already built) and its sha256 file attached. Branches, older releases and
  # repositories that are not on GitHub have none – then the code is cloned and built here, as before.
  fetch_release() {
    local base="${REPO%.git}" file="garten-$REF.tar.gz"
    curl -fsSL --retry 2 --max-time 300 -o "$WORK_DIR/$file" "$base/releases/download/$REF/$file" 2>/dev/null || return 1
    curl -fsSL --retry 2 --max-time 60 -o "$WORK_DIR/$file.sha256" "$base/releases/download/$REF/$file.sha256" 2>/dev/null || return 1
    # A missing archive means "build from source"; one that does not match its checksum is an error, not a reason to fall back.
    ( cd "$WORK_DIR" && sha256sum --quiet -c "$file.sha256" ) || die "The release archive $file does not match its sha256 checksum – not installing it."
    tar -xzf "$WORK_DIR/$file" -C "$NEW_DIR" --strip-components=1 --no-same-owner
  }

  local source
  step "Fetching Garten ($REF)"
  if fetch_release; then
    source="release archive"
  else
    source="built from source"
    printf '  No prebuilt archive for %s – building from source (takes a few minutes and needs about 1 GB of RAM).\n' "$REF"
    rm -rf "$NEW_DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$NEW_DIR"
    ( cd "$NEW_DIR"
      npm --prefix web ci --no-audit --no-fund --loglevel=error
      npm --prefix web run build >/dev/null
      rm -rf web/node_modules .git )         # only needed for the build
  fi
  [ -f "$NEW_DIR/web/dist/index.html" ] || die "The new version has no web/dist/index.html – nothing was changed."

  step "Installing server dependencies"
  ( cd "$NEW_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )   # the server needs no build scripts
  printf '%s (%s)\n' "$REF" "$source" > "$NEW_DIR/.garten-ref"

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
  else
    password="$(getenv ADMIN_PASSWORD)"      # still there only if an earlier run stopped before the server came up
  fi
  setenv PUBLIC_URL "$url"
  case "$mode" in
    proxy) unsetenv HOST; setenv TRUST_PROXY 1 ;;
    plain) unsetenv HOST; setenv TRUST_PROXY 0 ;;
  esac

  if [ -n "$password" ]; then
    ( umask 077; printf 'Garten – first admin\n  Address:  %s\n  E-mail:   %s\n  Password: %s\nChange the password after the first sign-in (Account → Password), then delete this file.\n' "$url" "$(getenv ADMIN_EMAIL)" "$password" > "$CREDS" )
  fi

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

  # A consistent copy of the SQLite database (WAL mode) while the server keeps running: VACUUM INTO reads one snapshot and writes it
  # to a new file. Run as the service user, so that any -wal/-shm file it has to create belongs to "garten", not to root.
  # The same snippet is in the garten command below (backup).
  snapshot_db() {
    runuser -u garten -- node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const [src, dst] = process.argv.slice(1); process.umask(0o077);
      const db = new DatabaseSync(src); db.exec("PRAGMA busy_timeout = 10000"); db.prepare("VACUUM INTO ?").run(dst); db.close();' "$1" "$2"
  }

  install -m 755 /dev/stdin /usr/local/bin/garten <<'EOF'
#!/usr/bin/env bash
# Helper for the Garten installation on this machine.
set -euo pipefail
ENVF=/etc/garten/garten.env
DATA=/var/lib/garten/data
url() { sed -n 's/^PUBLIC_URL=//p' "$ENVF" | tail -1; }
case "${1:-info}" in
  info)
    echo "Garten    $(url)   ($(systemctl is-active garten))   version $(node -p "require('/opt/garten/package.json').version" 2>/dev/null || echo ?)  $(cat /opt/garten/.garten-ref 2>/dev/null || true)"
    [ -f /root/garten.creds ] && echo "Login     see /root/garten.creds"
    echo "Data      $DATA      Settings  $ENVF"
    echo "Commands  garten update (latest release) | url <https://…|auto> | backup | logs"
    ;;
  update) exec bash /opt/garten/scripts/install-debian.sh ;;
  url) [ -n "${2:-}" ] || { echo "Usage: garten url <https://address | auto>" >&2; exit 1; }; GARTEN_URL="$2" exec bash /opt/garten/scripts/install-debian.sh ;;
  backup)
    # Online backup, the server keeps running. The live database files are left out and replaced by a consistent snapshot
    # (VACUUM INTO, run as the service user); it is taken first, so the Git repositories in the archive are at least as new
    # as the database that refers to them. Everything else in data/ (repos/, secret.key, known_hosts/) is copied as it is.
    out="/root/garten-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    chown garten:garten "$tmp"
    if [ -f "$DATA/specs.db" ]; then
      runuser -u garten -- node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const [src, dst] = process.argv.slice(1); process.umask(0o077);
        const db = new DatabaseSync(src); db.exec("PRAGMA busy_timeout = 10000"); db.prepare("VACUUM INTO ?").run(dst); db.close();' "$DATA/specs.db" "$tmp/specs.db"
    fi
    files=(); [ -f "$tmp/specs.db" ] && files+=(specs.db)
    # tar exits with 1 when a file changed while it was read (a commit in a team repository) – the archive is still usable.
    rc=0
    ( umask 077; tar -czf "$out" -C /var/lib/garten --anchored --exclude=data/specs.db --exclude=data/specs.db-wal --exclude=data/specs.db-shm \
        --warning=no-file-changed --warning=no-file-removed data \
        -C "$tmp" --transform='s,^specs\.db$,data/specs.db,' "${files[@]}" -C /etc/garten garten.env ) || rc=$?
    [ "$rc" -le 1 ] || { rm -f "$out"; echo "Backup failed (tar exit code $rc)." >&2; exit 1; }
    echo "Saved $out"
    echo "Restore: systemctl stop garten; rm -rf $DATA; tar xzf $out -C /var/lib/garten data; chown -R garten:garten $DATA; systemctl start garten"
    echo "         (the settings are in the archive as garten.env – copy them to $ENVF only if they are lost)"
    ;;
  logs) exec journalctl -u garten -n "${2:-100}" --no-pager ;;
  *) echo "Usage: garten [info|update|url <address>|backup|logs]" >&2; exit 1 ;;
esac
EOF

  # ---------------------------------------------------------------- switch over
  # Until here the running server was not touched. Now: stop it, move the current code to $APP_DIR.old, the new code into place,
  # start. If the new version does not answer, move the old code back and start that again.
  local port; port="$(getenv PORT)"; port="${port:-3000}"
  wait_up() { local i; for i in $(seq 60); do curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$port/healthz" 2>/dev/null && return 0; sleep 1; done; return 1; }
  # File-system sandbox: read-only system, private /tmp, no /home. It needs mount namespaces, which some containers do not allow –
  # it is a drop-in, so it can be taken away again if the service does not start with it.
  local SANDBOX=/etc/systemd/system/garten.service.d/sandbox.conf
  start_service() {
    mkdir -p "$(dirname "$SANDBOX")"
    printf '[Service]\nProtectSystem=strict\nReadWritePaths=%s\nProtectHome=true\nPrivateTmp=true\n' "$HOME_DIR" > "$SANDBOX"
    systemctl daemon-reload
    systemctl restart garten || true
    wait_up && return 0
    printf '\n! Garten did not start with the file-system sandbox (this container may not allow it) – trying again without it.\n' >&2
    rm -f "$SANDBOX"; systemctl daemon-reload; systemctl restart garten || true
    wait_up
  }

  # The database as it was right before the update, in case a new version changes it in a way the old one cannot read.
  # Overwritten by the next update; the data directory itself is never touched by an update or a rollback.
  if [ -f "$DATA_DIR/specs.db" ]; then
    rm -f "$HOME_DIR/pre-update.db"
    snapshot_db "$DATA_DIR/specs.db" "$HOME_DIR/pre-update.db" || die "Could not copy the database before the update – nothing was changed."
  fi

  step "Starting Garten"
  systemctl stop garten 2>/dev/null || true
  # A run that was interrupted between the two moves below leaves no $APP_DIR, only $APP_DIR.old – then that is the previous version.
  if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR.old"
    mv "$APP_DIR" "$APP_DIR.old"            # also takes along a git checkout made by older versions of this script
  fi
  mv "$NEW_DIR" "$APP_DIR"
  systemctl enable --quiet garten

  if ! start_service; then
    journalctl -u garten -n 30 --no-pager >&2 || true
    [ -d "$APP_DIR.old" ] || die "Garten did not start – see the log above (journalctl -u garten)."
    printf '\n! The new version (%s) did not start – going back to the previous one.\n' "$REF" >&2
    systemctl stop garten 2>/dev/null || true
    mv "$APP_DIR" "$NEW_DIR"                 # removed on exit
    mv "$APP_DIR.old" "$APP_DIR"
    start_service || die "Neither the new version nor the previous one started – see journalctl -u garten. The database from before the update is $HOME_DIR/pre-update.db."
    die "Update to $REF failed; the previous version is running again (see the log above). Data and settings were kept."
  fi

  # The password was only needed to create the first admin; it does not stay in the settings file.
  [ -z "$password" ] || unsetenv ADMIN_PASSWORD

  # Older versions of this script put Caddy in front of Garten; it is not used any more.
  if grep -qs "Garten's installer" /etc/caddy/Caddyfile; then
    systemctl disable --quiet --now caddy 2>/dev/null || true
    rm -rf /var/www/garten
  fi

  # ---------------------------------------------------------------- done
  printf '\n✓ Garten is running:  %s\n' "$url"
  [ -z "$password" ] || printf '  Sign in as  %s  with the password in  %s\n' "$(getenv ADMIN_EMAIL)" "$CREDS"
  case "$mode" in
    proxy) printf '  Point your reverse proxy at  http://%s:3000  (forward the Host header and X-Forwarded-*).\n' "${ip:-this machine}" ;;
    plain) printf '  No HTTPS: the app works online only (browsers allow offline mode only over HTTPS).\n' ;;
  esac
  printf '  More: garten info\n'
}

main "$@"
