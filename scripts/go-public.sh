#!/usr/bin/env bash
# Makes this Specs server reachable from the internet through a Cloudflare tunnel – no open port, no router setup.
# For the phone on the road and for agents that run in the cloud (Claude Code routines).
#
#   scripts/go-public.sh          start the tunnel, set PUBLIC_URL, print the address
#   scripts/go-public.sh prepare  only the checks before that: server up, demo password replaced (nothing goes public)
#   scripts/go-public.sh status   show the address and whether it answers
#   scripts/go-public.sh stop     close the tunnel, back to http://localhost
#
# Without further setup this is a "quick tunnel": https://<random>.trycloudflare.com. Its address changes whenever the
# tunnel restarts (reboot!). For a fixed address put TUNNEL_TOKEN (Cloudflare Zero Trust → Tunnels, public hostname →
# http://specs:3000) and PUBLIC_URL=https://specs.example.com into .env; the script then starts that tunnel instead.
set -euo pipefail
cd "$(dirname "$0")/.."

DC="docker compose"
ENVFILE="${COMPOSE_ENV_FILES:-.env}"   # the file docker compose reads its variables from
DEMO_PASSWORD=admin-demo-1
say() { printf '%s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

getenv() { [ -f "$ENVFILE" ] && sed -n "s/^$1=//p" "$ENVFILE" | tail -1 || true; }
setenv() { touch "$ENVFILE"; chmod 600 "$ENVFILE"; local rest; rest=$(grep -v "^$1=" "$ENVFILE" || true); { [ -n "$rest" ] && printf '%s\n' "$rest"; printf '%s=%s\n' "$1" "$2"; } > "$ENVFILE"; }
unsetenv() { [ -f "$ENVFILE" ] || return 0; local rest; rest=$(grep -v "^$1=" "$ENVFILE" || true); if [ -n "$rest" ]; then printf '%s\n' "$rest" > "$ENVFILE"; else : > "$ENVFILE"; fi; }

PORT="${PORT:-$(getenv PORT)}"; PORT="${PORT:-3000}"
LOCAL="http://localhost:$PORT"
ADMIN="${ADMIN_EMAIL:-$(getenv ADMIN_EMAIL)}"; ADMIN="${ADMIN:-admin@localhost}"

command -v docker >/dev/null || die "docker is not installed"
command -v curl >/dev/null || die "curl is not installed"

wait_for() { # url seconds [extra curl options]
  local url=$1 n=$2; shift 2
  for _ in $(seq "$n"); do curl -fsS -o /dev/null --max-time 5 "$@" "$url" 2>/dev/null && return 0; sleep 1; done
  return 1
}
# The new host name exists in DNS only seconds after the tunnel starts. Asking Cloudflare's resolver directly avoids the
# local resolver remembering "no such host" from a first, too early question.
wait_public() { wait_for "$1/healthz" "$2" --doh-url https://1.1.1.1/dns-query || wait_for "$1/healthz" 10; }
quick_url() { $DC --profile public logs --no-log-prefix tunnel 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -1 || true; }

# Runs inside the container (node is there, the host needs nothing): does the demo password still open the admin account?
# check → exit 0 if it does. change → reads the new password from stdin and sets it.
ACCOUNT_JS='
const [email, demo, mode] = process.argv.slice(1);
const api = (path, body, cookie) => fetch("http://127.0.0.1:3000/api" + path, { method: "POST", headers: { "content-type": "application/json", "x-specs": "1", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const login = await api("/auth/login", { email, password: demo });
if (!login.ok) process.exit(3);
if (mode === "check") process.exit(0);
let pw = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) pw += c;
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const res = await api("/me/password", { current: demo, password: pw.replace(/\r?\n$/, "") }, cookie);
if (!res.ok) { console.error((await res.json().catch(() => ({}))).error ?? "HTTP " + res.status); process.exit(4); }
'
account() { $DC exec -T specs node --input-type=module -e "$ACCOUNT_JS" -- "$ADMIN" "$DEMO_PASSWORD" "$1"; }

secure_admin() {
  account check </dev/null 2>/dev/null || return 0
  say "The admin account $ADMIN still has the demo password from the README."
  say "It must not go onto the internet like that – choose a new one (at least 12 characters)."
  local pw="${SPECS_NEW_PASSWORD:-}" again
  if [ -z "$pw" ]; then
    [ -t 0 ] || die "Run this in a terminal, or pass the new password as SPECS_NEW_PASSWORD."
    read -rs -p "New password: " pw; echo
    read -rs -p "Again:        " again; echo
    [ "$pw" = "$again" ] || die "The two entries differ – nothing was changed."
  fi
  [ "${#pw}" -ge 12 ] || die "At least 12 characters – nothing was changed."
  [ "$pw" != "$DEMO_PASSWORD" ] || die "That is the demo password."
  printf '%s' "$pw" | account change || die "The password could not be changed."
  say "✓ New password set for $ADMIN."
}

prepare() {
  if ! wait_for "$LOCAL/healthz" 1; then
    say "Starting Specs …"; $DC up -d specs >/dev/null
    wait_for "$LOCAL/healthz" 120 || die "Specs does not answer on $LOCAL – see: docker compose logs specs"
  fi
  secure_admin
}

start() {
  prepare

  local url token; token="$(getenv TUNNEL_TOKEN)"
  if [ -n "$token" ]; then
    url="$(getenv PUBLIC_URL)"
    case "$url" in https://*) ;; *) die "TUNNEL_TOKEN is set – also put the tunnel's address into .env as PUBLIC_URL=https://…" ;; esac
    say "Starting your Cloudflare tunnel for $url …"
    $DC --profile public-named up -d tunnel-named >/dev/null
    setenv SPECS_TUNNEL named
  else
    say "Starting a Cloudflare quick tunnel …"
    $DC --profile public up -d tunnel >/dev/null
    url=""
    for _ in $(seq 60); do url="$(quick_url)"; [ -n "$url" ] && break; sleep 1; done
    [ -n "$url" ] || die "The tunnel did not report an address – see: docker compose logs tunnel"
    setenv PUBLIC_URL "$url"; setenv SPECS_TUNNEL quick
  fi
  setenv TRUST_PROXY 1
  $DC up -d specs >/dev/null            # restarts the server only if PUBLIC_URL changed
  wait_for "$LOCAL/healthz" 120 || die "Specs did not come back – see: docker compose logs specs"

  say
  if wait_public "$url" 90; then say "✓ Specs is reachable at  $url"
  else say "! Tunnel is up at  $url  – but it did not answer from this machine yet (DNS can lag a minute). Try it on the phone."; fi
  cat <<EOF

  Phone        open $url, sign in, then "Add to Home Screen". Open every team once while online –
               after that specs, the garden and your answers work offline and sync when you are back.
  Agents       MCP address: $url/mcp
               Members & Git → "Agent setup" has the .mcp.json and the prompt to copy; "Agent trigger" starts the routine.
  This PC      sign in at $url too – http://localhost:$PORT no longer keeps you signed in while the tunnel is on.
               The computer has to stay awake:  systemd-inhibit --what=sleep:idle sleep infinity
EOF
  [ -n "$token" ] || say "  Address      changes when the tunnel restarts (reboot). Then run this script again and use the new address
               on the phone – unsynced changes stay under the old address, so sync before you shut down."
  say "  Stop         scripts/go-public.sh stop"
}

stop() {
  $DC --profile public --profile public-named rm -sf tunnel tunnel-named >/dev/null 2>&1 || true
  if [ "$(getenv SPECS_TUNNEL)" = quick ]; then unsetenv PUBLIC_URL; unsetenv TRUST_PROXY; fi
  unsetenv SPECS_TUNNEL
  $DC up -d specs >/dev/null
  wait_for "$LOCAL/healthz" 120 || die "Specs did not come back – see: docker compose logs specs"
  say "✓ Tunnel closed. Specs is local again: $LOCAL"
}

status() {
  local mode url; mode="$(getenv SPECS_TUNNEL)"; url="$(getenv PUBLIC_URL)"
  [ -n "$mode" ] || { say "No tunnel. Specs is local: $LOCAL"; return 0; }
  if [ "$mode" = quick ]; then
    local now; now="$(quick_url)"
    [ -n "$now" ] || { say "✗ The tunnel is not running (address was $url). Run scripts/go-public.sh again."; return 1; }
    [ "$now" = "$url" ] || { say "✗ The tunnel restarted and has a new address: $now (Specs still expects $url). Run scripts/go-public.sh again."; return 1; }
  fi
  if wait_public "$url" 5; then say "✓ $url answers.   MCP: $url/mcp"; else say "✗ $url does not answer."; return 1; fi
}

case "${1:-start}" in
  start) start ;;
  prepare) prepare; say "✓ Ready. scripts/go-public.sh opens the tunnel." ;;
  stop) stop ;;
  status) status ;;
  *) die "Usage: scripts/go-public.sh [start|prepare|status|stop]" ;;
esac
