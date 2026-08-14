# MCP surface runbook

Operator moves for the remote MCP surface (the truthful-surface wave:
honest per-token tools/list, per-client surfaces, strict-params grace
period, STARTER_OPS). Current behavior only; release history lives in
`CHANGELOG.md` + git. Companion references: the generated
[`docs/TOOL_CATALOG.md`](../TOOL_CATALOG.md) (every non-localOnly op with
scope/starter/gate), `docs/protocol/MEMORY_VERBS_v1.md` (surface modes),
`docs/protocol/MCP_META_CHANNELS.md` (`_meta` conventions).

Everything below assumes `gbrain serve --http` (the OAuth transport).
tools/list is recomputed **per request** — none of these moves needs a
server restart unless it says so.

## Move 1 — flip a publish gate

Gated ops (`Operation.publishGateKey`): `list_skills` / `get_skill` /
`list_brain_skillpack` (`mcp.publish_skills`) and `advisor`
(`mcp.publish_advisor`). Both gates default OFF: the ops are hidden from
remote tools/list AND denied at call time.

```bash
gbrain config set mcp.publish_skills true      # or mcp.publish_advisor
```

**Expected outcome:** the very next tools/list from any token includes the
gated ops (dual-plane read, DB > file, per request — no restart). Flipping
back to `false` hides them again on the next list; the call-time backstop
denies immediately with the machine-readable detail
`config_key=mcp.publish_skills`. A failed gate READ during tools/list
resolves to hidden (fail-closed consent posture), never a failed list.

## Move 2 — rescope a client's surface

```bash
gbrain auth clients --usage            # who needs it? (op counts, surface, last seen)
gbrain auth rescope-client <client_id> --surface starter   # verbs | starter | full | clear
```

Usage counts only successful calls (`success` / `success_with_warnings`) —
a client flooding denials or errors shows zero usage, so denied traffic can
never argue its way into a wider surface or the starter derivation.

**Expected outcomes:**
- The client's NEXT request resolves the new surface (per-request
  ceiling-bounded resolution: `min(server --surface ceiling, client row)`)
  — the client must re-issue tools/list to see the change; cached tool
  lists in a long-lived session go stale until it does.
- An audit row lands in `mcp_request_log` (`operation='surface_change'`,
  params carrying actor/old/new/via) — every surface mutation writes one
  (rescope CLI, admin endpoint, request_tools persist):

```sql
SELECT created_at, params FROM mcp_request_log
 WHERE operation = 'surface_change' ORDER BY created_at DESC LIMIT 10;
```

- A CLI rescope sets `surface_set_by='operator'` — the operator lock:
  `request_tools` persist cannot override it. (The persist itself is
  rate-limited per client and meters actual writes only — `dry_run`
  previews are free.)
- The advisor's `mcp-client-fit` collector proposes exactly this command
  for full-surface clients whose 30d usage fits STARTER_OPS.

**Default for NULL-surface clients** (including future DCR
self-registrations):

```bash
gbrain config set mcp.default_surface_dcr starter   # verbs | starter | full
```

Dual-plane read (DB > file), applied on each client's next request,
ceiling-bounded like everything else; unset means NULL-surface clients
resolve to the server ceiling (pre-wave behavior). Pre-seed important
clients with an explicit `rescope-client --surface full` before flipping it.

## Move 3 — flip strict params from warn to reject

`mcp.strict_params` governs unknown-argument handling at dispatch:
`warn` (default) accepts the call, surfaces `_meta.warnings` + a
model-visible notice block, and logs the success as
`status='success_with_warnings'`; `reject` returns `invalid_params` with
did-you-mean suggestions.

**Flip criterion (evidence-based, amendment 13):** near-zero
`success_with_warnings` rows over 30 days of production traffic —

```sql
SELECT count(*) FROM mcp_request_log
 WHERE status = 'success_with_warnings'
   AND created_at > now() - interval '30 days';
```

When that count is ~0, clients have adapted; flip:

```bash
gbrain config set mcp.strict_params reject
```

**Expected outcome (schema emission change):** besides rejecting unknown
args, tools/list schemas change shape — each `inputSchema` closes with
`additionalProperties: false` and declares the `_meta`/`dry_run`
passthrough keys (D14.1), keeping schema-validating clients aligned with
the server's reject posture. Read per request; flipping back to `warn`
reopens the schemas on the next list. A transient config-read failure
cannot re-open the grace period: dispatch holds the last successfully
read mode per process, so a reject-mode server stays reject through a
config outage. `test/mcp-tool-defs.test.ts` pins
both emission states; the default stays `warn` until the project-level
flip (see TODOS.md, strict_params reject-flip).

## Move 4 — change STARTER_OPS

```bash
bun run scripts/derive-starter-ops.ts [--days 30]
```

reads production `mcp_request_log` through the shared usage reader
(automation-shaped clients excluded, per-client DISTINCT-op sets weighted
by client count), prints a proposed daily-driver block with a provenance
header. Paste it into `src/mcp/surface.ts` (replacing
`FALLBACK_DAILY_OPS`) — the script never edits files. Then:

```bash
bun test test/mcp-surface.test.ts        # membership + monotonicity: verbs ⊆ starter ⊆ full
bun run scripts/generate-tool-catalog.ts # refresh the Starter column; freshness guard fails CI otherwise
```

`VERB_NAMES` + `whoami` + `request_tools` + the agent lane are composed in
`surface.ts` and always included — the derivation only proposes the daily
slice. The advisor's drift finding (`mcp_starter_ops_drift`) is the
standing prompt to re-run this move.

## Incident levers

- **`GBRAIN_MCP_FORCE_SURFACE=verbs|starter|full`** — narrow-only clamp
  (FOV-6a): it `min()`s into every resolved surface and can NEVER widen
  past the configured ceiling; widening requires an explicit `--surface`
  restart. Use it to clamp a misbehaving deployment down to verbs without
  touching client rows.
- **`GBRAIN_SEARCH_SALVAGE=off`** — restores pre-wave all-or-nothing
  retrieval (no allSettled salvage, strict budget, no minKeep failsafe)
  if the fail-loud retrieval behavior itself misbehaves.

**Total embed outage, what to expect (ENG-6):** the query cache is
uncacheable by construction during a full embedding outage — `query_cache`
keys on embedding similarity, and both store and lookup no-op on a null
embedding. Expect cache hit rate ~0 (`gbrain search stats`) and
keyword-only degraded results carrying `_meta.retrieval.degraded` stages
plus the model-visible block on empty results. This is the designed
degradation, not a second incident; only PARTIAL degradations (expansion
failed, vector arm failed) get short-TTL cache entries.

## The honest-catalog metric (trend to zero)

The wave's working metric (amendment 33): op-level call-time denials the
tools/list filter should have made impossible. serve-http logs them as
`status='denied_after_list'` — scope denials, publish-gate backstop
denials (`config_key=...`), and bound-client fence OP-level denials
(`fence=op`). Argument-level slug-fence denials are legitimate for a
listed op and excluded (D10).

```sql
SELECT count(*) FROM mcp_request_log
 WHERE status = 'denied_after_list'
   AND created_at > now() - interval '30 days';
```

A non-zero trend means list-time and call-time predicates drifted (a bug)
or a client is calling ops it was never shown (staleness/guessing) —
either way, worth a look at the offending rows' `token_name` + `operation`.

## First 5 minutes after a deploy

Migrate-then-serve is atomic per process (initSchema runs before listen).
Post-deploy checks, in order:

1. **tools/list count per token class** — for each token class you run
   (admin/full, read/starter, agent-only, slug-bound): list tools and eyeball
   the count (starter ≈ the STARTER_OPS size, full ≈ the TOOL_CATALOG count,
   agent-only = its minimal lane). Counts are also queryable:
   `SELECT token_name, params->>'tool_count' FROM mcp_request_log WHERE operation='tools/list' ORDER BY created_at DESC LIMIT 10;`
2. **Empty-query probe shows the degraded block** — call `search` with a
   nonsense query; the empty result must carry a second content block
   ("0 results. … clean miss." or degraded stages) + `_meta.retrieval`.
3. **Workerless submit warns** — `submit_agent` while no worker runs must
   still succeed and carry `queue_state.warning` (worker_alive false).
4. **put_page lint fields present** — put an uncited page; the response
   must carry `writer_lint.top_findings` (or the zero-findings shape).

### As a smoke-tests.d drop-in

The smoke-test skill runs user scripts from `~/.gbrain/smoke-tests.d/*.sh`.
Save the four checks as a drop-in (fill in URL + token):

```bash
#!/usr/bin/env bash
# ~/.gbrain/smoke-tests.d/check-remote-mcp.sh — truthful-surface deploy checks
set -euo pipefail
URL="${GBRAIN_MCP_URL:?set GBRAIN_MCP_URL}"; TOK="${GBRAIN_MCP_TOKEN:?set GBRAIN_MCP_TOKEN}"
call() { curl -sf "$URL" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$1"; }
# 1. tools/list responds and reports a sane count
N=$(call '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name"' | wc -l)
[ "$N" -gt 0 ] && echo "OK tools/list: $N tools" || { echo "FAIL tools/list"; exit 1; }
# 2. empty search carries the model-visible degradation block
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"zzqx-no-such-thing-xkcd"}}}' \
  | grep -q '0 results' && echo 'OK empty-result loudness' || { echo 'FAIL empty-result block'; exit 1; }
# 3+4 need write/agent scopes — run only when the token has them:
#   submit_agent → response contains "queue_state"; put_page → "writer_lint".
```
