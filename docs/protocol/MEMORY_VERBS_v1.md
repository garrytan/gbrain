# MEMORY_VERBS v1 — the memory wire protocol

GBrain's frozen memory-verb interface over MCP: `recall`, `remember`,
`entity`, `synthesize`, `forget`, plus the additive `context_pack` and
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
- **Adding a VERB is additive, not a version bump.** `context_pack` and `delta`
  sit alongside the original five at `protocol_version: 1`. New verbs are
  new optional surface a v1 client discovers via tool-listing; the existing verbs
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

### recall(query?, entity?, budget_tokens?, budget_policy?, source_id?, since?, session_id?, limit?, …) — read

Retrieve saved facts and (with `query`) budget-packed page snippets.

- `entity` scopes the FACTS arm; `query` runs the hybrid-search arm over
  pages; both present ⇒ both arms run.
- `since`: ISO 8601 date/datetime — filters the FACTS arm only in v1. (The
  reference implementation also accepts relative phrases like `"8 hours ago"`
  as a convenience; only ISO 8601 is part of the frozen contract.) The window
  is measured on event time (`valid_from`, falling back to `created_at`) and
  composes with `entity` and `session_id` in the same query, before the
  per-arm limit. An unparseable value is rejected with `invalid_params`.
- `limit` is a PER-ARM cap (facts and search results each).
- `budget_tokens`: SERVER-side packing — by default facts pack first and search
  results take the remainder. A positive finite numeric budget is floored;
  other values leave the arrays unbudgeted. Costs are `ceil(fact.length/4)` or
  `ceil(title.length/4) + ceil(chunk.length/4)`, not exact tokenizer counts or
  JSON-envelope size. `budget_used` reports estimated packed tokens and
  `dropped_count` counts candidates that did not fit. Legacy compatibility:
  a positive numeric budget below one reports budget zero but keeps all facts
  and no pages; this old path is not a strict fractional cap.
- `budget_policy`: optional `facts_first | query_first`, default `facts_first`.
  Explicit facts-first preserves the default behavior, including its fractional
  quirk. Query-first applies only with a nonblank `query` and positive finite
  numeric budget: pack the ranked page prefix first, then the fact prefix in the
  remaining budget. If the floored budget is zero, keep neither arm. An exhausted
  remainder keeps zero second-arm items. Each arm stops at its first oversized
  item without skipping to smaller later items or truncating. No page hits or
  an oversized first page leaves the full budget for facts. Without a nonblank
  query, use exact legacy facts-first behavior; without a positive finite budget,
  keep the unbudgeted arrays. Candidate selection, source grants, visibility,
  fact filters and per-arm limits are unchanged.
- `source_id`: optional concrete source for both evidence arms. An explicit
  `default` is distinct from omission. The existing authorization resolver
  checks the selector before source existence; denied, nonexistent and archived
  sources fail rather than falling back to a broader grant. Omission preserves
  the existing context/grant scope and local federation behavior.
  Selector failures use stamped v1 errors: `scope_denied` for a denied source,
  `not_found` for a missing or archived source, and `invalid_params` for an
  invalid selector. `detail` preserves the underlying source-error classification.
- No embedding provider configured? The search arm degrades to keyword-only
  and the response notes `search_degraded` — never an error.

Response — an additive SUPERSET of the plain facts envelope on EVERY call
(the base fact fields are unchanged; JSON consumers ignore additions):

| field | type | semantics |
|---|---|---|
| `protocol_version` | int | always present (every verb, every call) |
| `facts[]` | array | the base fact fields, PLUS per fact: `fact_id` (opaque STRING — the value `forget` accepts; the numeric `id` remains alongside it for compatibility) and `provenance` (the stored source attribution) |
| `total` | int | count of facts returned |
| `results[]` | array | search arm only: `slug`, `title`, `chunk`, `evidence`, `create_safety`, `provenance` (origin page slug) |
| `search_degraded` | string? | present when keyword-only fallback fired |
| `budget_tokens` / `budget_used` / `dropped_count` | int? | present for a positive finite numeric budget, including when its floor is zero |
| `budget_packing` | object? | present only when a valid `budget_policy` is supplied; effective policy and per-arm accounting |

`budget_packing` contains `policy` (effective `facts_first | query_first`),
`applied` (whether the requested budget policy applied), `reason`, and `facts` /
`results` objects with `candidates`, `kept`, `dropped`, and `used`. Candidates are
the already authorized, filtered, limit-capped arms, not all rows in the brain.
`candidates = kept + dropped` per arm; the sums of `used` and `dropped` equal
`budget_used` and `dropped_count` when those frozen fields exist. On unbudgeted
calls, `used` counts the unchanged returned evidence and frozen budget fields
remain absent. Omitting the policy adds no new response field. Optional null or
empty-string policy values normalize to absence through the ordinary transport
validator; invalid types and enum values are `invalid_params`.

Reasons, in precedence order: `no_query` (query-first requested without a nonblank
query), `no_positive_finite_budget`, `budget_below_one` (a positive budget floors to zero),
`no_candidates`, `first_items_exceed_budget` (candidates exist but neither prefix
head fits), and `packed`. Ineligible query-first requests report effective
`facts_first` and `applied: false`. `packed` does not guarantee all required
evidence fit, or that a returned page answers the question.

For `budget_below_one`, eligible query-first applies an empty budget to both
arms and reports `applied: true`. Facts-first preserves the legacy sub-one
overrun, but reports `applied: false` rather than claiming its evidence fit.
With an explicit CLI policy, local and thin callers preserve an explicit
`--source default` over ambient selectors and reject missing or archived
sources. The policy accepts concrete source IDs, not `__all__`; omit the source
selector to retain the existing context/grant scope. Legacy calls without the
policy retain their existing CLI source-resolution and fractional-budget rules.

**Opt-in caller:** for a question about saved page evidence with a tight budget:

```bash
gbrain recall --query 'zebra telescope' --budget-tokens 75 --budget-policy query_first --json
```

```json
{"name":"recall","arguments":{"query":"zebra telescope","budget_tokens":75,"budget_policy":"query_first"}}
```

Keep entity-first, event/session-filtered and fact-focused callers on facts-first;
an irrelevant matching page can otherwise displace their useful fact. The policy
does not change `context_pack` or existing third-party calls. Maintained caller
guidance lives in `skills/query/SKILL.md` and `skills/brain-ops/SKILL.md`; schema
advertisement and documentation are not evidence of native-harness adoption.
Require an observed opted-in call in a fresh conversation before claiming it.

The named CLI accepts the policy before or after the other options, including
`--budget-policy=query_first`, and rejects missing/invalid values. Its omitted
and explicit facts-first paths preserve legacy integer parsing of budget text
(`0.5` becomes an absent budget). Only explicit query-first with a nonblank query
preserves numeric fractions until the operation floors them. MCP and
`gbrain call recall` use the numeric operation contract above. Opt-in named calls
forward fact filters and use the remote operation on thin clients; `--watch`,
`--since-last-run`, `--rollup`, and `--as-context` cannot be combined with the new
policy option. Their existing calls without the option are unchanged.
For opted-in local and thin `--json` calls, selector rejections and remote
operation failures emit structured errors on stdout and exit nonzero. Remote
error messages, suggestions, details and documentation references are retained,
including ordinary read errors without mutation receipts.

**evidence** (enum, zero-LLM heuristic): `alias_hit` \| `exact_title_match` \|
`high_vector_match` \| `keyword_exact` \| `weak_semantic` — why each result
matched. **create_safety** (enum): `exists` (a page for this already exists)
\| `probable` (likely exists; check before creating) \| `unknown` (no
signal). The derivation of both is implementation-defined and may improve;
the values are frozen.

### remember(fact, provenance, ttl?, entity?, kind?, visibility?, confidence?, request_id?) — write

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
- `confidence`: number in `[0, 1]`, DEFAULT `1.0`. Convention: `1.0` =
  human-reviewed; machine-assessed facts carry a graded value `< 1` (matching
  what extraction/critique emit). Out-of-range or non-numeric values are
  rejected with `invalid_params` and a self-correcting suggestion. The value
  rides decay (`confidence × exp(-age/halflife)`) and surfaces in recall
  results.

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

#### entity open_threads loop backing (additive)

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

All five are absent on threads not backed by a loop row and on servers that
do not implement them; a server that omits them still certifies. Same propagation to the
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

#### synthesize compose status (additive)

Every response additionally carries four ADDITIVE-FOREVER fields (optional;
a server that omits them still certifies):

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

### forget(id, reason?, request_id?) — write

Expire a fact by its opaque string id (from `remember` or
`recall.facts[].fact_id` — never a page slug). Idempotent: re-forgetting an
already-expired fact returns `expired: false` (success); unknown id ⇒
`not_found`. Facts are expired with an audit trail, never deleted.

Response: `{ id, expired, reason, protocol_version }`.

#### Durable write receipts (additive)

Write receipts distinguish accepted work from committed memory. Their public
shape is `{request_id, state, retry_after_ms, revision?, outcome?, persistence?,
compacted?, created_at?, updated_at?, diagnostic?}`. States are `queued`, `running`,
`recovering`, `committed`, `conflict`, `failed`, and `cancelled`. Terminal
receipts have `retry_after_ms: null`. `persistence.mode` distinguishes a
filesystem-backed write from an intentional database-only write; Git progress
does not change the meaning of committed memory.

Nonterminal receipts may include `diagnostic: {age_ms, assessment, reason,
next_action, observed_at?}`. `assessment` is `pending`, `blocked`, or `stalled`;
`reason` uses a closed allowlist, and `next_action` is `poll` or `inspect_owner`.
Age measures time since acceptance, not time since the last lease renewal.
`observed_at` is omitted when fresh dependency evidence is unavailable. These
fields are advisory, not proof of owner death or permission to repair. Honor
`retry_after_ms`, retain the original request ID, and inspect the existing owner
before replay when advised. Older servers may omit `diagnostic` entirely.

A pending write is a protocol `unavailable` error with a populated suggestion,
`protocol_version: 1`, and optional `write_request` and `write_error` fields.
It never returns a success `status` or `expired` value. `write_error` carries
the detailed concurrency reason without changing the frozen protocol error
enum. A committed receipt retains the original memory-verb success fields.
Compaction may remove diagnostics, but must preserve those frozen result fields.

The optional caller-generated UUID `request_id` identifies one write intent.
Retry the same verb with the original arguments and the same ID to recover
its outcome, including on the verbs-only surface. A terminal request is never
executed again. Corrected input requires a new ID. Clients that lose a response
without retaining its request ID cannot assume that retrying content is an
exactly-once write. A receipt never contains queued content, recovery paths or
execution credentials.

The starter/full helpers `get_write_request`, `list_write_requests`, and
`cancel_write_request` require write scope and explicit current operation
permission. Existing operation snapshots are not widened by an upgrade.
Helpers expose only the caller's currently authorized receipts; a foreign,
missing, or no-longer-accessible UUID has the same `not_found` response. Their
absence from a verb-only or agent-only grant does not prevent same-verb replay.
See [concurrent writes](../guides/concurrent-writes.md) for exact read guarantees,
bounded retention, ownership transfer, and the explicit regrant procedure.

For `forget`, a committed source- and visibility-scoped withdrawal is the
durable memory outcome. Its filesystem mirror may remain pending; stale
source imports must still respect the withdrawal.

### context_pack(entities, budget_tokens?, since?, session_id?, include_private?) — read, zero LLM

One deterministic, budget-packed bundle for a set of standing
entities — entity cards + open threads + hot facts. Built for **session
boundaries**: call it at session start to warm cold context, and immediately
after compaction to rehydrate what the summary dropped. Composes existing arms
(`entity` card builder + the hot-facts arm); never calls an LLM.

`entities` is comma-separated, capped at 8 (the response echoes the capped list). `budget_tokens` packs
server-side (cards first, then facts; each item costs its rendered line and the
envelope + section headers are reserved first, so `text` fits the budget) and the
response reports `budget_used` (the token estimate of `text`) + `dropped_count`
— it never trims client-side. `since` filters
open-thread events to those after the cursor. **Visibility is WORLD-ONLY by
default** on every arm (a pack is injected into an agent context window that may
be logged or synced to a cloud model). `include_private` widens ALL arms in
lockstep, and is honored ONLY for trusted-local callers (`remote === false`); a
remote caller never widens (fail-closed).

Response: `{ protocol_version, entities, cards[], open_threads[], facts[], text,
degraded_reason?, budget_tokens?, budget_used?, dropped_count? }`. `text` is the
pre-rendered, envelope-wrapped injectable block; with `budget_tokens` it is
rendered from the packed sets and never exceeds the declared budget.

### delta(since?, entities?, budget_tokens?, session_id?, include_private?) — read, zero LLM

"What changed since T" for heartbeats — pages updated after
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
budget_used?, dropped_count? }`. `budget_tokens` applies to pages and facts
(pages pack first, then facts) — each item costs its rendered line and the
envelope + section headers are reserved first, so `text` (rendered from the
packed sets) fits the declared budget. **Threads are never truncated**: every
open-thread event after `since` is delivered and its line is reserved ahead of
pages and facts, so `dropped_count` / `has_more` count only pages and facts.
If the envelope + headers + threads alone exceed `budget_tokens`, all threads
are still returned and `budget_used` (the token estimate of `text`) reports the
real rendered size, which then exceeds the budget. Cursor semantics are the v1
page keyset alone — facts and threads never move `next_cursor`. `since` is
always normalized ISO (never the raw input string).

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
