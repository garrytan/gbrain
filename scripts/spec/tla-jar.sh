#!/usr/bin/env bash
# Prints the path of a verified tla2tools.jar, downloading it into a cache on first use.
#
#   TLA2TOOLS=<path>   use this jar (it is still checked against the pinned sha256)
#   TLA_CACHE=<dir>    cache directory (default ${XDG_CACHE_HOME:-~/.cache}/gbrain/tla)
#
# Exit 2 with a code on stderr: TLA_JAR_DOWNLOAD_FAILED (network; rerun), TLA_JAR_SHA_MISMATCH (never rerun:
# the bytes are not the reviewed release), TLA_JAVA_MISSING (install Java 11+).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tla-tools.env
. "$here/tla-tools.env"
command -v java >/dev/null || { echo "TLA_JAVA_MISSING: java not found; install a JDK 11 or later (CI uses temurin 21)" >&2; exit 2; }
sha_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
if [ -n "${TLA2TOOLS:-}" ]; then
  jar="$TLA2TOOLS"
  [ -f "$jar" ] || { echo "TLA_JAR_MISSING: TLA2TOOLS=$jar does not exist; unset it to download v$TLA_TOOLS_VERSION into the cache" >&2; exit 2; }
else
  cache="${TLA_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/gbrain/tla}"
  mkdir -p "$cache"
  jar="$cache/tla2tools-$TLA_TOOLS_VERSION.jar"
  if [ ! -f "$jar" ]; then
    tmp="$jar.part.$$"
    if ! curl -sSfL --retry 3 --retry-delay 2 "$TLA_TOOLS_URL" -o "$tmp"; then
      rm -f "$tmp"
      echo "TLA_JAR_DOWNLOAD_FAILED: could not download $TLA_TOOLS_URL; rerun, or download it yourself and set TLA2TOOLS to its path" >&2
      exit 2
    fi
    mv "$tmp" "$jar"
  fi
fi
actual="$(sha_of "$jar")"
if [ "$actual" != "$TLA_TOOLS_SHA256" ]; then
  [ -z "${TLA2TOOLS:-}" ] && rm -f "$jar"
  echo "TLA_JAR_SHA_MISMATCH: $jar has sha256 $actual, not the pinned $TLA_TOOLS_SHA256 (scripts/spec/tla-tools.env). Do not retry; a changed pin needs review." >&2
  exit 2
fi
echo "$jar"
