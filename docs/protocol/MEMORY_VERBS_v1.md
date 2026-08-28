# MEMORY_VERBS v1 — the memory wire protocol

GBrain's frozen memory-verb interface over MCP: `recall`, `remember`,
`entity`, `synthesize`, `forget`, plus (v0.45.7, additive) `context_pack` and
`delta` — seven verbs, all at `protocol_version: 1`. The contract every harness can rely on the
way every Postgres client relies on the wire protocol — and the contract any
OTHER memory server can implement and certify against
(`gbrain protocol conformance --target <endpoint>`).

```
agent (any MCP harness)
   │  remember("picked Stripe over Adyen", provenance: "chat 2026-06-11")
   ▼
seven verbs  recall ─ remember ─ entity ─ synthesize ─ forget ─ context_pack ─ delta
   │   self-describing envelopes: protocol_version, evidence, provenance,
   │   budget meta, cost block, enumerated error codes + a populated fix
   ▼
your brain (reference implementation: gbrain; any conformant server)
```

**Machine-readable spec:** `gbrain protocol --json` emits the input schemas
from the live operation definitions plus the response-shape registry — doc and
code structurally cannot drift; conformance validates live responses against
the same registry.

## Versioning policy (the point of the freeze)

- Every field NAME and its SEMANTICS in v1 are frozen forever — never removed,
  renamed, or re-typed; meanings never change.
- New OPTIONAL params and new OPTIONAL response fields may be added at any
  time (additive-forever). A conformant CLIENT must ignore unknown fields; a
  conformant SERVER must never reject unknown-to-v1 additions it itself ships.
- `protocol_version` (integer, starts at `1`) rides every verb response and
  every verb error. It increments ONLY on a breaking change, which by policy
  requires a new `MEMORY_VERBS_v2` document — expected never.
- Conformance pins a minimum version; certification asserts shape, enum
  validity, contract behavior, and round-trips — never ranking quality (that
  is BrainBench's job).
- Enum values are part of the contract. Where an enum's DERIVATION is
  implementation-defined (noted per field), implementations may improve the
  derivation without a version bump; the values and their meanings stay fixed.
- **Adding a VERB is additive, not a version bump.** v0.45.7 grew the frozen set
  from 5 to 7 (`context_pack`, `delta`) at `protocol_version: 1`. New verbs are
  new optional surface a v1 client discovers via tool-listing; the existing five
  keep stamping `1`. Bumping `protocol_version` would rewrite the frozen five's
  wire output and break every client that pins `== 1` — so we don't.

## Install (the 4-command quickstart)

```bash
gbrain init --pglite                                      # 2-second local brain
claude mcp add gbrain -- gbrain serve --surface verbs     # the memory-verb surface
gbrain remember "I prefer dark mode in every editor" --provenance demo --entity people/me
gbrain recall --entity people/me                          # …now ask your agent in a NEW session
```

> Memories agents save are readable by every agent connected to this brain;
> pass `visibility: "private"` for local-CLI-only facts.

If `claude` is not found: install Claude Code first, or use a block below.

**Codex**
```bash
codex mcp add gbrain -- gbrain serve --surface verbs
```

**Grok Build** (verify with `grok mcp doctor gbrain` — the add is lazy)
```bash
grok mcp add gbrain -e "GBRAIN_HOME=$HOME" -- gbrain serve --surface verbs
```

**opencode** (verify with `opencode mcp list` — the add is lazy, and list SPAWNS the server)
```bash
opencode mcp add gbrain --env GBRAIN_HOME=$HOME -- gbrain serve --surface verbs
```

**OpenClaw / any stdio MCP host** — register the server command
`gbrain serve --surface verbs`. Remote brains: `gbrain serve --http` on the
host, then `gbrain connect https://host/mcp --token gbrain_xxx --install` on
each client.

**Surface modes:** `--surface verbs` exposes EXACTLY the seven verbs —
advertised list AND dispatch are filtered fail-closed (a hidden op returns
`unknown_tool` even when called by name). `--surface starter` exposes the
~27-op daily-driver set (`STARTER_OPS` in `src/mcp/surface.ts`): the seven
verbs plus the daily brain-tool slice, the agent lane, `whoami`, `capture`, and the
`request_tools` discovery meta-op (re-derivable from production usage via
`scripts/derive-starter-ops.ts`). Monotonic by construction: verbs ⊆ starter ⊆ full
(pinned by test) — starter extends the ladder ABOVE verbs and never changes
verb semantics. `--surface full` (the default) exposes every operation,
verbs included. Why default full: verbs/starter are for agents and
quickstarts; full preserves existing advanced tooling. Persist a default
with `gbrain config set mcp_surface verbs`.

**Ceiling semantics (OAuth HTTP transport):** the server-resolved surface
is a CEILING, not the final answer. Each request resolves
`min(ceiling, client row surface ?? mcp.default_surface_dcr ?? ceiling)` —
so a verbs-pinned server always serves verbs regardless of client rows,
while a full server can narrow individual clients
(`gbrain auth rescope-client <id> --surface starter`) or let them narrow
themselves via `request_tools` (never past the ceiling; an operator-set
row is locked against self-service). Recomputed per request — rescopes
take effect on the client's next request; clients should re-issue
tools/list after a surface change. stdio and the legacy bearer transport
have no per-client row: they serve the server-resolved surface directly.

## The verbs

### recall(query?, entity?, budget_tokens?, since?, session_id?, limit?, …) — read

Retrieve saved facts and (with `query`) budget-packed page snippets.

- `entity` scopes the FACTS arm; `query` runs the hybrid-search arm over
  pages; both present ⇒ both arms run.
- `since`: ISO 8601 date/datetime — filters the FACTS arm only in v1. (The
  reference implementation also accepts relative phrases like `"8 hours ago"`
  as a convenience; only ISO 8601 is part of the frozen contract.)
- `limit` is a PER-ARM cap (facts and search results each).
- `budget_tokens`: SERVER-side packing — facts pack first (limit-capped
  one-liners, so search-arm starvation is bounded), search results take the
  remainder. The estimator is char/4 (±10–15%); `budget_used` reports packed
  tokens, `dropped_count` what didn't fit. Never advisory, never client-side.
- No embedding provider configured? The search arm degrades to keyword-only
  and the response notes `search_degraded` — never an error.

Response — an additive SUPERSET of the pre-v1 facts envelope on EVERY call
(all legacy fields unchanged; JSON consumers ignore additions):

| field | type | semantics |
|---|---|---|
| `protocol_version` | int | always present (every verb, every call) |
| `facts[]` | array | legacy fact fields unchanged, PLUS per fact: `fact_id` (opaque STRING — the value `forget` accepts; the legacy numeric `id` stays for pre-v1 consumers) and `provenance` (the stored source attribution) |
| `total` | int | count of facts returned |
| `results[]` | array | search arm only: `slug`, `title`, `chunk`, `evidence`, `create_safety`, `provenance` (origin page slug) |
| `search_degraded` | string? | present when keyword-only fallback fired |
| `budget_tokens` / `budget_used` / `dropped_count` | int? | present when `budget_tokens` was passed |

**evidence** (enum, zero-LLM heuristic): `alias_hit` \| `exact_title_match` \|
`high_vector_match` \| `keyword_exact` \| `weak_semantic` — why each result
matched. **create_safety** (enum): `exists` (a page for this already exists)
\| `probable` (likely exists; check before creating) \| `unknown` (no
signal). The derivation of both is implementation-defined and may improve;
the values are frozen.

### remember(fact, provenance, ttl?, entity?, kind?, visibility?) — write

Save ONE fact with mandatory attribution.

- `provenance` (REQUIRED, free text ≤500 chars, stored verbatim): e.g.
  `"conversation 2026-06-12"`, `"user said in chat"`, `"import: notes.md"`.
  Empty ⇒ `provenance_required` error with a fix.
- `entity`: set whenever the fact is about a specific person/company/project —
  entity-scoped recall will not find unattributed facts.
- `ttl`: duration shorthand (`"30d"`, `"12h"`, `"45m"`) or an absolute ISO 8601
  timestamp. ISO-8601 DURATIONS (`P30D`) are rejected with a self-correcting
  suggestion. Omitted ⇒ never expires.
- `kind`: `event` \| `preference` \| `commitment` \| `belief` \| `fact`
  (default).
- `visibility`: `world` (DEFAULT — readable by every agent connected to this
  brain; required for the remote remember→recall round-trip) \| `private`
  (local CLI reads only). The init quickstart carries the consent line.

Response: `{ id, status, status_text, entity_slug, valid_until,
protocol_version }` (+ `degraded_dedup: true` when no embedding provider —
near-duplicates may insert; dedup and supersession ride embedding similarity).

- `id` — opaque STRING (gbrain serializes integers; another implementation may
  use UUIDs). On `status: "duplicate"` it is the EXISTING fact's id.
- `status` — `inserted` \| `duplicate` \| `superseded`. **Branch on `status`,
  never on `status_text`** (the human rendering). Supersession is
  implementation-defined; the reference rule: same entity + same kind +
  similarity above the dedup threshold + different text = the new fact
  supersedes the old ("X at acme-example" → "X left acme-example").
- Omitted optional inputs echo as `null`, never absent.

### entity(name) — read, zero LLM, p99 < 100ms

One known person/company/project card. NEVER errors on a miss.

Resolution (frozen precedence): alias > exact slug > exact title > slug-suffix.
When multiple pages share an exact title, canonical entity types (`person`,
`company`, `organization`, `entity`) outrank note/conversation containers;
most-recently-touched breaks ties within the same match shape. A non-entity
exact-title page remains a valid fallback. Multi-hit ⇒ best match's card +
runners-up in `suggestions`. Miss ⇒ `found: false` + keyword near-misses with
`create_safety` hints.

Response: `{ protocol_version, found, latency_ms, card?, suggestions? }`.
Card: `{ entity{slug,title,type}, aka[], summary, last_touched{updated_at,
last_retrieved_at, last_timeline_date}, open_threads[], edges[],
backlink_count, active_fact_count }`.

- `summary` passes the same privacy fences as `get_page` (takes + private
  facts stripped); remote callers never see private facts in the card.
- `open_threads` (best-effort in v1): active commitment-kind facts + timeline
  entries from the last 90 days, capped at 3.

#### entity open_threads loop backing (v0.47, additive)

On brains running the open-loop engine, `open_threads` entries may
additionally be DERIVED from `open_loops` rows (they rank ahead of raw
commitment facts under the same cap; a loop-projected fact is never
duplicated as a second entry). This is the sanctioned implementation-defined
derivation of the frozen surface: such entries keep `kind: 'commitment'`
(the frozen enum is unchanged) even for unanswered-thread and
pending-decision loops — the ADDITIVE-FOREVER optional fields disambiguate:

- `direction` — `owed_by_me` / `owed_to_me` (commitments), `my_turn`
  (unanswered inbound: the owner owes a reply), `their_turn` (unanswered
  outbound: the owner is waiting on them).
- `due` — ISO due date when known, else null.
- `counterparty` — the person slug the loop groups under.
- `status` — loop status (always `open` on cards).
- `loop_id` — the open_loops row id (`loops_close` takes it).

All five are absent on threads not backed by a loop row and on pre-v0.47
servers; a server that omits them still certifies. Same propagation to the
per-entity cards and top-level `open_threads` of `context_pack`.
- `edges`: top ~10 typed edges, mentions excluded, out-edges first.
- The p99 < 100ms promise is op-layer latency (transport excluded), CI-gated
  on a 20K-page corpus. 200K validation recipe below.

### synthesize(question, since?, until?) — read, EXPENSIVE

`[EXPENSIVE / SLOW — makes LLM calls, seconds-to-minutes latency, costs
money]` — the deliberately-priced slow verb. Prefer `recall`/`entity` for
lookups; use synthesize only when the answer requires combining evidence
across pages.

Response: `{ answer, sources[], gaps[], cost{model, input_tokens,
output_tokens, usd_estimate}, protocol_version }`.

- The `cost` block is a BEST-EFFORT AGGREGATE (retries/multi-call flows sum;
  cache hits may undercount; token fields are `null` when a provider returns
  no accounting). Honest signal, not an invoice.
- No LLM configured ⇒ the protocol error `unavailable` with a fix — never a
  fake answer.

#### synthesize compose status (v0.45.x, additive)

Every response additionally carries four ADDITIVE-FOREVER fields (absent on
pre-v0.45.x servers; a server that omits them still certifies):

- `synthesis_status` — how `answer` was produced: `ok` (LLM synthesis) or
  `extractive_fallback` (the LLM compose step failed but retrieval succeeded —
  `answer` is an extractive digest quoting ONLY retrieved pages, `sources`
  cite the digested pages). The remaining enum values (`empty_answer`,
  `not_json`, `output_truncated`, `no_llm`, `model_unusable`, `llm_error`)
  name compose-failure states a non-verb `think` surface may report; the verb
  converts them to the fallback or a typed error and never emits them itself.
- `pages_gathered` / `takes_gathered` — retrieval counts behind the answer.
- `warnings` — machine-stable pipeline warning codes (e.g.
  `LLM_OUTPUT_NOT_JSON`, `LLM_OUTPUT_TRUNCATED`, `SYNTHESIS_EMPTY_ANSWER`,
  `LLM_CALL_FAILED: <class>` where `<class>` is one of the closed set
  `timeout` | `rate_limited` | `network` | `provider_error` — raw provider
  detail never rides the wire, `MODEL_NOT_USABLE:<reason>`).

Precedence (frozen): compose failure + NON-EMPTY gather ⇒
`extractive_fallback` — the digest is composed exclusively from gathered
pages, never fabricated. Compose failure + EMPTY gather ⇒ the protocol error
`unavailable` with message `retrieved 0 pages; compose failed: <warning-code>`
(an empty gather NEVER produces an answer). Provider/transport failures at
call time (429 / timeout / 5xx / network) are caught into `llm_error` and
follow the same precedence. No LLM configured stays the `unavailable`
configure-and-retry error regardless of gather — an extractive digest would
mask the misconfiguration forever. Refusals parse as `not_json` (coarse on
purpose, no dedicated status); a `max_tokens`-cut envelope parses as
`output_truncated` (warning `LLM_OUTPUT_TRUNCATED`) so a too-small output
budget is distinguishable from malformed model output.

### forget(id, reason?) — write

Expire a fact by its opaque string id (from `remember` or
`recall.facts[].fact_id` — never a page slug). Idempotent: re-forgetting an
already-expired fact returns `expired: false` (success); unknown id ⇒
`not_found`. Facts are expired with an audit trail, never deleted.

Response: `{ id, expired, reason, protocol_version }`.

### context_pack(entities, budget_tokens?, since?, session_id?, include_private?) — read, zero LLM

v0.45.7 (issue #1). One deterministic, budget-packed bundle for a set of standing
entities — entity cards + open threads + hot facts. Built for **session
boundaries**: call it at session start to warm cold context, and immediately
after compaction to rehydrate what the summary dropped. Composes existing arms
(`entity` card builder + the hot-facts arm); never calls an LLM.

`entities` is comma-separated, capped at 8 (the response echoes the capped list). `budget_tokens` packs
server-side (cards first, then facts) and the response reports
`budget_used` + `dropped_count` — it never trims client-side. `since` filters
open-thread events to those after the cursor. **Visibility is WORLD-ONLY by
default** on every arm (a pack is injected into an agent context window that may
be logged or synced to a cloud model). `include_private` widens ALL arms in
lockstep, and is honored ONLY for trusted-local callers (`remote === false`); a
remote caller never widens (fail-closed).

Response: `{ protocol_version, entities, cards[], open_threads[], facts[], text,
degraded_reason?, budget_tokens?, budget_used?, dropped_count? }`. `text` is the
pre-rendered, envelope-wrapped injectable block.

### delta(since?, entities?, budget_tokens?, session_id?, include_private?) — read, zero LLM

v0.45.7 (issue #1). "What changed since T" for heartbeats — pages updated after
the cursor (oldest first) + facts recorded after the cursor + open-thread
events after the cursor. Lets a periodic wake maintain warm state in
O(changes) instead of re-deriving. Provide `since` (ISO 8601) OR a
`session_id` whose cursor carries the last wake. Delivery is **at-least-once**:
when a budget or the fetch limit drops pages, `has_more: true` is set and the
session cursor advances only to the newest DELIVERED page — the undelivered
tail surfaces on the next wake, never silently lost. Dedup is cursor-based (a
delivered page reappears only if it changes again). Same world-only-default +
`include_private` fail-closed rule as `context_pack`. The session cursor is
keyed `(source_id, client_id, session_id)` — authenticated remote callers are
namespaced by their auth client id, auth-less remotes share the `'remote'`
sentinel, and `'local'` is RESERVED for the trusted CLI/hook lane, so a remote
harness can never read or advance the local lane's cursor.

Delivery is at-least-once via a **keyset cursor `(updated_at, slug)`**: a cluster
of pages sharing one `updated_at` (bulk syncs stamp identical timestamps) pages
deterministically by slug, so a >fetch-limit cluster drains across wakes instead
of livelocking. Stateless callers resume by passing the response's
`next_cursor.since` + `next_cursor.slug` back as `since` + `since_slug`;
`session_id` callers get this automatically.

Response: `{ protocol_version, since, pages[], facts[], threads[], text,
has_more, next_cursor: { since, slug }, degraded_reason?, budget_tokens?,
budget_used?, dropped_count? }`. `text` is rendered from the budget-packed sets
(it honors the declared budget) and `since` is always normalized ISO (never the
raw input string).

## Latency classes (per verb)

Published so harness authors place calls by cost, not by learning at timeout:

| Verb | Class | Notes |
|---|---|---|
| `entity` | zero-LLM, **p99 < 100ms** | CI-gated on a 20K-page corpus (below). Safe per entity-bearing message. |
| `context_pack` | zero-LLM, sub-second | Fan-out capped at 8 entities. Session boundaries, not per-message. Push path passes a wall-clock deadline and returns a PARTIAL pack (`degraded_reason`) rather than overrun. |
| `delta` | zero-LLM, sub-second | O(changes). Heartbeats — pull path only (there is no push heartbeat); session cursors expire after 7 idle days. |
| `recall` | zero-LLM (keyword) to one embedding call (when `query` is passed) | Sub-second typical; the `query` arm adds one embedding round-trip. |
| `remember` / `forget` | write, sub-second | One durable write; `remember` adds one embedding call for dedup when a provider is configured. |
| `synthesize` | **EXPENSIVE / SLOW** | LLM calls, seconds-to-minutes, costs money. Never place on a hot or ambient path. |

## Error contract (uniform across all verbs)

```json
{ "error": "<code>", "message": "...", "suggestion": "problem + cause + fix",
  "detail": "freeform specifics", "protocol_version": 1 }
```

Codes (coarse on purpose — codes are for branching; `detail` carries the
story): `invalid_params`, `provenance_required`, `not_found`, `scope_denied`,
`unavailable` (a required dependency cannot serve: no API key, gateway down,
model refusal — configure/retry, not a server bug), `budget_unsatisfiable`
(RESERVED — schema-listed, never returned in v1), `internal`.

Every verb error carries a POPULATED `suggestion`. Specific cases: `recall` on
an empty brain returns empty arrays (success, not an error); auth/scope
failures fail closed via the standard dispatch.

## Trust boundary

Verbs are ordinary operations: they inherit fail-closed `remote` semantics,
OAuth scope enforcement (`remember`/`forget` are write-scope), and per-source
isolation on every read. Remote callers see `visibility = world` facts only.

## Conformance + certification

```bash
gbrain protocol conformance                                  # self-certify (stdio)
gbrain protocol conformance --target http://localhost:3131/mcp --token gbrain_xxx
gbrain protocol conformance --target "bun run src/cli.ts serve"
gbrain protocol conformance --synthesize                     # also live-call synthesize
```

Pass criteria: response SHAPE (required fields, enum validity), CONTRACT
BEHAVIOR (provenance rejected when empty; budget arithmetic consistent;
entity miss ⇒ `found:false`, not an error; private facts absent from remote
cards; idempotent forget), and ROUND-TRIP (remember → recall by entity — a
plain indexed read, deterministic). It does NOT judge ranking quality.
Entity-card cases need a seedable page (`put_page`); against verbs-only
targets they skip honestly. `--synthesize` is cost-gated: with no LLM key it
asserts the clean `unavailable` error (what CI does); with a key it spends
real tokens.

Conformance is a LIVE test that WRITES: it seeds a marker-suffixed synthetic
entity page (`people/conformance-<marker>`, when the target exposes
`put_page`) and writes/expires facts through `remember`/`forget`. Point it at
write-capable credentials and a brain you're comfortable leaving those
synthetic artifacts in — they're marker-named for easy cleanup, not
auto-deleted. The fixture set ships as data
(`test/fixtures/memory-verbs/cases.json`) and seeds BrainBench's
protocol-compliance arm. gbrain's CI certifies its own stdio + HTTP
transports; external certification is best-effort tooling until a second
implementation exists.

## Observability (local only)

Every verb call appends one line to
`~/.gbrain/integrations/memory-verbs/usage.jsonl` — **local JSONL only, never
uploaded**, stats-only (lock-free rotation may drop lines; POSIX O_APPEND
line-atomic, best-effort on Windows). `gbrain protocol stats [--days N]`
aggregates per-verb calls, error rate, latency, budget drops, entity hit rate,
and the measured TTHW (install → first verb call, from the
`protocol_installed_at` stamp). `gbrain doctor` carries a
`memory_verbs_usage` health line.

## 200K-page latency validation (manual recipe)

CI gates entity() p99 < 100ms on a 20K-page corpus
(`test/entity-card-perf.slow.test.ts`). To validate at 200K, edit the
constants at the top of that file (`PAGES = 200_000`, `LINKS = 1_000_000`,
`ALIASES = 300_000`, `FACTS = 400_000`) and run
`bun test test/entity-card-perf.slow.test.ts --timeout=1800000` — seeding
dominates (~minutes); the measured calls report p50/p99 + the ratio guard.
