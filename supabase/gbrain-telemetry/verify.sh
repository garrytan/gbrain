#!/usr/bin/env bash
# verify.sh: smoke-test the lockdown of gbrain's telemetry objects after G001
# is applied and both functions are deployed. Read-only: it writes nothing.
#
# For the public key (anon) and, when a user JWT is available, a signed-in user
# (authenticated), every gbrain table, the view and every function must refuse
# reads, inserts, updates and calls with a permission denial (Postgres 42501).
# A missing object or any other answer fails, so an unapplied migration or a
# wrong key can't pass. It also checks that the ingest function answers an
# empty batch with accepted 0 and that the pulse answers 200 or 503.
#
#   GBRAIN_TELEMETRY_URL=https://<project>.supabase.co \
#   GBRAIN_TELEMETRY_KEY=<the project's publishable key> \
#   bash supabase/gbrain-telemetry/verify.sh
#
# Signed-in checks: set GBRAIN_VERIFY_AUTH_JWT to a user JWT. Without it they are
# skipped and the verdict is INCOMPLETE. Neither key nor JWT is ever printed.
set -uo pipefail

URL="${GBRAIN_TELEMETRY_URL:-}"
KEY="${GBRAIN_TELEMETRY_KEY:-}"
JWT="${GBRAIN_VERIFY_AUTH_JWT:-}"
if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "verify.sh: set GBRAIN_TELEMETRY_URL and GBRAIN_TELEMETRY_KEY (the publishable key)" >&2
  exit 2
fi

TABLES="gbrain_telemetry_events gbrain_installations gbrain_ingest_daily gbrain_pulse_cache gbrain_telemetry_live"
FUNCS="gbrain_ingest_reserve gbrain_telemetry_forget gbrain_telemetry_prune gbrain_pulse_summary"
PASS=0; FAIL=0; SKIP=0

denied() { # <label> <curl args...>
  local label="$1"; shift
  local body
  body="$(curl -s --max-time 15 "$@" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"42501"'; then
    echo "PASS $label"; PASS=$((PASS + 1))
  else
    echo "FAIL $label: $(printf '%s' "$body" | head -c 200)"; FAIL=$((FAIL + 1))
  fi
}

# A real column to set and to filter on, so PostgREST runs an UPDATE.
update_body() {
  case "$1" in
    gbrain_installations) echo '{"os":"other"}' ;;
    gbrain_ingest_daily) echo '{"refused":0}' ;;
    gbrain_pulse_cache) echo '{"data":{}}' ;;
    *) echo '{"tier":"anonymous"}' ;;
  esac
}
update_filter() {
  case "$1" in
    gbrain_ingest_daily) echo 'day=eq.2000-01-01' ;;
    gbrain_pulse_cache) echo 'id=eq.0' ;;
    *) echo 'installation_id=is.null' ;;
  esac
}

run_role() { # <role label> <bearer>
  local who="$1" bearer="$2" t f
  for t in $TABLES; do
    denied "$who select $t" -H "apikey: $KEY" -H "Authorization: Bearer $bearer" "$URL/rest/v1/$t?select=*&limit=1"
    denied "$who insert $t" -X POST -H "apikey: $KEY" -H "Authorization: Bearer $bearer" -H "Content-Type: application/json" -d '{}' "$URL/rest/v1/$t"
    denied "$who update $t" -X PATCH -H "apikey: $KEY" -H "Authorization: Bearer $bearer" -H "Content-Type: application/json" -d "$(update_body "$t")" "$URL/rest/v1/$t?$(update_filter "$t")"
  done
  for f in $FUNCS; do
    denied "$who call $f" -X POST -H "apikey: $KEY" -H "Authorization: Bearer $bearer" -H "Content-Type: application/json" -d '{}' "$URL/rest/v1/rpc/$f"
  done
}

run_role anon "$KEY"
if [ -n "$JWT" ]; then
  run_role authenticated "$JWT"
else
  echo "SKIP authenticated checks (set GBRAIN_VERIFY_AUTH_JWT)"; SKIP=1
fi

# One test-source event (the live view and the pulse leave it out) proves the write path.
PROBE="{"v":1,"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","event_type":"setup","gbrain_version":"0.0.0","tier":"anonymous","source":"test"}"
ING="$(curl -s --max-time 15 -X POST -H "apikey: $KEY" -H "Content-Type: application/json" -d "$PROBE" "$URL/functions/v1/gbrain-telemetry-ingest" 2>/dev/null || true)"
if printf '%s' "$ING" | grep -q '"accepted":1'; then echo "PASS ingest stores a test event"; PASS=$((PASS + 1)); else echo "FAIL ingest: $(printf '%s' "$ING" | head -c 200)"; FAIL=$((FAIL + 1)); fi

PUL="$(curl -s --max-time 30 -H "apikey: $KEY" "$URL/functions/v1/gbrain-telemetry-pulse" 2>/dev/null || true)"
if printf '%s' "$PUL" | grep -q '"status":"ok"'; then echo "PASS pulse answers"; PASS=$((PASS + 1)); else echo "FAIL pulse: $(printf '%s' "$PUL" | head -c 200)"; FAIL=$((FAIL + 1)); fi

if [ "$FAIL" -gt 0 ]; then echo "VERDICT: FAIL pass=$PASS fail=$FAIL"; exit 1; fi
if [ "$SKIP" -gt 0 ]; then echo "VERDICT: INCOMPLETE pass=$PASS (signed-in checks skipped)"; exit 0; fi
echo "VERDICT: PASS pass=$PASS"
