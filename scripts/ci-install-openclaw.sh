#!/usr/bin/env bash
# Tier 2 (e2e.yml) installs the OpenClaw CLI with `npm install -g`, which resolves
# every transitive dependency fresh against the registry. Two things go wrong there:
#
#   * a registry or network stall hangs an attempt (before the per-attempt
#     `timeout` it burned the whole 30 m Tier 2 budget), so each attempt is
#     bounded and a failed one is retried after a short pause;
#   * a dependency published moments ago is not yet visible for every package of
#     its release (`npm error code ETARGET` / `E404` for a version that exists a
#     minute later: @aws-sdk/credential-provider-node@^3.972.86 on the 2026-10-12
#     master Tier 2 run). The flat 10 s retries were over in half a minute and
#     missed the window, so a registry race gets its own longer back-off.
#
# Any other failure keeps the generic retries. Nothing else is retried or hidden:
# after the last attempt the step fails with npm's own log.
#
# Environment (defaults are the CI values; the test overrides them):
#   OPENCLAW_SPEC                   package spec, default openclaw@2026.4.9
#   OPENCLAW_INSTALL_ATTEMPT_S      per-attempt timeout, default 120
#   OPENCLAW_INSTALL_RETRY_SLEEP_S  pause after a generic failure, default 10 (3 attempts)
#   OPENCLAW_INSTALL_RACE_SLEEPS_S  pauses after a registry race, default "20 40 80" (4 attempts)
set -uo pipefail

spec="${OPENCLAW_SPEC:-openclaw@2026.4.9}"
attempt_timeout="${OPENCLAW_INSTALL_ATTEMPT_S:-120}"
retry_sleep="${OPENCLAW_INSTALL_RETRY_SLEEP_S:-10}"
race_sleeps="${OPENCLAW_INSTALL_RACE_SLEEPS_S:-20 40 80}"
log="$(mktemp "${TMPDIR:-/tmp}/openclaw-install.XXXXXX")"
trap 'rm -f "$log"' EXIT

generic_failures=0
race_failures=0
attempt=0
while :; do
  attempt=$((attempt + 1))
  if timeout "$attempt_timeout" npm install -g "$spec" 2>&1 | tee "$log"; then
    exit 0
  fi
  if grep -Eq 'npm (error|ERR!) code E(TARGET|404)\b' "$log"; then
    race_failures=$((race_failures + 1))
    # shellcheck disable=SC2086
    set -- $race_sleeps
    if [ "$race_failures" -gt "$#" ]; then
      echo "::error::openclaw install: the registry still does not serve a version $spec resolves to after $race_failures attempts (ETARGET/E404)" >&2
      exit 1
    fi
    eval "pause=\${$race_failures}"
    echo "::warning::openclaw install attempt $attempt hit a registry race (ETARGET/E404: a dependency version is not visible yet); retrying in ${pause}s" >&2
  else
    generic_failures=$((generic_failures + 1))
    if [ "$generic_failures" -ge 3 ]; then
      echo "::error::openclaw install failed after $attempt attempts" >&2
      exit 1
    fi
    pause="$retry_sleep"
    echo "::warning::openclaw install attempt $attempt failed or timed out; retrying in ${pause}s" >&2
  fi
  sleep "$pause"
done
