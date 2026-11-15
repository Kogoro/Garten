#!/usr/bin/env bash
# Packs a prebuilt Garten for a release: what the server needs at runtime, with the web app already built (web/dist).
# The release workflow runs it; install-debian.sh downloads the result, so a server never has to build the web app itself.
#
#   npm --prefix web ci && npm --prefix web run build
#   scripts/release-tarball.sh v0.12.0 dist      → dist/garten-v0.12.0.tar.gz and dist/garten-v0.12.0.tar.gz.sha256
#
# The archive holds one directory, garten-<tag>/. Server dependencies are not included – the target installs them with
#   npm ci --omit=dev --ignore-scripts
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:?usage: scripts/release-tarball.sh <tag> [output directory]}"
out="${2:-dist}"
name="garten-$tag"

[ -f web/dist/index.html ] || { echo "web/dist/index.html is missing – build the web app first (npm --prefix web run build)." >&2; exit 1; }

mkdir -p "$out"
out="$(cd "$out" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/$name/web"
cp -R server shared scripts package.json package-lock.json "$stage/$name/"
cp -R web/dist "$stage/$name/web/dist"
for f in README.md LICENSE LICENSE.md; do [ -f "$f" ] && cp "$f" "$stage/$name/"; done

# Same bytes for the same input: fixed owner, sorted names, file times from the last commit.
mtime="$(git log -1 --format=%cI 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner --mtime="$mtime" -cf - "$name" | gzip -9n > "$out/$name.tar.gz"
( cd "$out" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256" )
echo "$out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1))"
