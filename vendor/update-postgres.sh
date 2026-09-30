#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL https://registry.npmjs.org/postgres/-/postgres-3.4.9.tgz -o "$WORK/upstream.tgz"
echo '183dea741d31d73f7180523a71d443eb1bb64a9d9608e1287b79ad9f207911ed17aeb2f93def9ee020a726b44c9cbd7362d44366641055bbceb6d2e72832e76b  upstream.tgz' | (cd "$WORK" && sha512sum -c -)
mkdir "$WORK/postgres"
tar -xzf "$WORK/upstream.tgz" --strip-components=1 -C "$WORK/postgres"
patch --no-backup-if-mismatch -d "$WORK/postgres" -p1 < "$ROOT/patches/postgres@3.4.9.patch"
awk '/^diff --git / { keep = ($3 ~ /^a\/src\//) } keep' "$ROOT/patches/postgres@3.4.9.patch" |
  sed 's|a/src/|a/cf/src/|g; s|b/src/|b/cf/src/|g' > "$WORK/cf.patch"
patch --no-backup-if-mismatch -d "$WORK/postgres" -p1 < "$WORK/cf.patch"
curl -fsSL https://raw.githubusercontent.com/porsager/postgres/v3.4.9/UNLICENSE -o "$WORK/postgres/UNLICENSE"
echo 'b5065838cbac452dfc855ba6e6e031481ad2c68406f70d21ead9321374653e6c  UNLICENSE' | (cd "$WORK/postgres" && sha256sum -c -)
if [[ "${1:-}" == '--check' ]]; then
  diff -ru "$ROOT/vendor/postgres" "$WORK/postgres"
elif [[ $# -eq 0 ]]; then
  rm -rf "$ROOT/vendor/postgres"
  cp -R "$WORK/postgres" "$ROOT/vendor/postgres"
else
  echo 'Usage: bash vendor/update-postgres.sh [--check]' >&2
  exit 2
fi
