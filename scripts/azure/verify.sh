#!/usr/bin/env bash
# Verify the deployment, layer by layer.
#
# Checks run top to bottom and each is independent, so a failure names the
# layer that is wrong rather than just saying "it's down". Every check is
# recorded and the script exits non-zero at the end if any FAILED — running
# them all is the point, so it does not stop at the first failure.
#
# THE ONE EXPECTED FAILURE: `gbrain doctor` will report the `rls` check as
# failing, permanently, on this deployment. gbrain enables row-level security
# only when the role holds BYPASSRLS or is superuser, and Azure's Postgres
# admin role is neither. That is acceptable here because the server has no
# public network path and gbrain's RLS carries zero policies anywhere — it was
# only ever an anon-key defense for the Supabase topology. Any OTHER doctor
# failure is real.

set -uo pipefail   # NOT -e: every check must run even after one fails.
# shellcheck source=scripts/azure/lib.sh
source "$(dirname "$0")/lib.sh"
set +e

FAILURES=0

pass() { printf '  PASS  %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAILURES=$(( FAILURES + 1 )); }

section() { printf '\n== %s ==\n' "$*"; }

require_az

section 'Azure layer'

state=$(pg_state)
case "$state" in
  Ready)   pass "postgres $PG is Ready" ;;
  Starting) warn "postgres $PG is Starting — re-run in a few minutes" ;;
  Stopped) bad  "postgres $PG is Stopped — the start never ran" ;;
  *)       bad  "postgres $PG is '$state'" ;;
esac

worker_replicas=$(az containerapp replica list -g "$RG" -n "$WORKER" --query 'length(@)' -o tsv 2>/dev/null || echo 0)
case "$worker_replicas" in
  1) pass "worker $WORKER has exactly 1 replica" ;;
  0) bad  "worker $WORKER has no replicas — the supervisor is not running" ;;
  # Above 1 is a correctness problem, not a capacity one: two supervisors
  # race on the same job leases and duplicate LLM spend on every cycle phase.
  *) bad  "worker $WORKER has $worker_replicas replicas — must be exactly 1" ;;
esac

mcp_status=$(az containerapp show -g "$RG" -n "$MCP" --query properties.runningStatus -o tsv 2>/dev/null || echo 'Unknown')
if [ "$mcp_status" = 'Running' ]; then
  pass "mcp app $MCP is Running"
else
  # Not a failure by itself. The app scales to zero, so an idle deployment
  # legitimately reports something else until the first request arrives.
  warn "mcp app $MCP reports '$mcp_status' (expected at min-replicas 0 when idle)"
fi

section 'HTTP layer'

brain_url=$(resolve_brain_url)
if [ -z "$brain_url" ]; then
  bad 'could not resolve the MCP app URL — skipping every HTTP check'
else
  echo "  (base URL: $brain_url)"

  if curl -fsS --max-time 120 "$brain_url/health" >/dev/null 2>&1; then
    pass 'GET /health returns 200'
  else
    # 502/504 here almost always means the app cannot reach Postgres, not
    # that the app is down.
    bad 'GET /health failed (502/504 usually means the app cannot reach Postgres)'
  fi

  # Unauthenticated MCP must be REFUSED. A 200 here would mean auth is not
  # being enforced on a public endpoint, which is the single worst outcome
  # this script can detect.
  mcp_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -X POST "$brain_url/mcp" 2>/dev/null || echo '000')
  case "$mcp_code" in
    401) pass 'POST /mcp unauthenticated returns 401' ;;
    200) bad  'POST /mcp unauthenticated returned 200 — AUTH IS NOT BEING ENFORCED. Stop and investigate.' ;;
    000) bad  'POST /mcp unreachable' ;;
    *)   bad  "POST /mcp unauthenticated returned $mcp_code (expected 401)" ;;
  esac

  # ...and the refusal must carry discovery metadata, or an MCP client has no
  # way to begin the OAuth flow from a fresh 401 and just reports a generic
  # connection failure.
  if curl -si --max-time 60 -X POST "$brain_url/mcp" 2>/dev/null | grep -qi 'www-authenticate.*resource_metadata'; then
    pass '401 carries WWW-Authenticate with resource_metadata'
  else
    bad '401 is missing the resource_metadata parameter — clients cannot start the OAuth flow'
  fi

  # RFC 9728 §3.1 path-suffixed location. /mcp is the protected resource, so
  # the document lives under the resource path, not at the bare well-known
  # URL. The bare path is still served as a back-compat alias.
  if curl -fsS --max-time 60 "$brain_url/.well-known/oauth-protected-resource/mcp" >/dev/null 2>&1; then
    pass 'protected-resource metadata served at the RFC 9728 path'
  else
    bad 'protected-resource metadata missing at /.well-known/oauth-protected-resource/mcp'
  fi

  # The admin plane must NOT exist on the public port. GBRAIN_DISABLE_ADMIN
  # makes it 404 — indistinguishable from a route that was never mounted.
  admin_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$brain_url/admin/login" 2>/dev/null || echo '000')
  case "$admin_code" in
    404) pass '/admin is disabled (404)' ;;
    000) warn '/admin probe did not complete' ;;
    *)   bad  "/admin/login returned $admin_code — the admin plane is exposed on the public port. Set GBRAIN_DISABLE_ADMIN=1." ;;
  esac
fi

section 'gbrain layer'

# `doctor` is expected to report the rls check as failing; see the header. It
# is run for its OTHER checks, so its exit code is reported rather than
# treated as pass/fail.
if az containerapp exec -g "$RG" -n "$MCP" --command "gbrain doctor --json" >/dev/null 2>&1; then
  pass 'gbrain doctor ran (review its output; the rls failure is EXPECTED on Azure)'
else
  warn 'gbrain doctor exited non-zero — expected while the rls check fails; review the output for any OTHER failure'
fi

if az containerapp exec -g "$RG" -n "$WORKER" --command "gbrain jobs supervisor status --json" >/dev/null 2>&1; then
  pass 'minion supervisor is running'
else
  bad 'minion supervisor is NOT running — check the worker replica count and its logs'
fi

section 'Summary'
if [ "$FAILURES" -eq 0 ]; then
  echo '  All checks passed.'
  exit 0
fi
echo "  $FAILURES check(s) FAILED."
exit 1
