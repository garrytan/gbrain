# MEMORY_VERBS v1 — the memory wire protocol

GBrain's frozen five-verb memory interface over MCP: `recall`, `remember`,
`entity`, `synthesize`, `forget`. The contract every harness can rely on the
way every Postgres client relies on the wire protocol — and the contract any
OTHER memory server can implement and certify against
(`gbrain protocol conformance --target <endpoint>`).

```
agent (any MCP harness)
   │  remember("picked Stripe over Adyen", provenance: "chat 2026-06-11")
   ▼
five verbs ── recall ── remember ── entity ── synthesize ── forget
   │   self-describing envelopes: protocol_version, evidence, provenance,
   │   budget meta, cost block, enumerated error codes + a populated fix
   ▼
your brain (gbrain reference implementation; any conformant server)
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

## Install (the 3-command quickstart)

```bash
gbrain init --pglite                                      # 2-second local brain
claude mcp add gbrain -- gbrain serve --surface verbs     # the five-verb surface
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

**OpenClaw / any stdio MCP host** — register the server command
`gbrain serve --surface verbs`. Remote brains: `gbrain serve --http` on the
host, then `gbrain connect https://host/mcp --token gbrain_xxx --install` on
each client.

**Surface modes:** `--surface verbs` exposes EXACTLY the five verbs —
advertised list AND dispatch are filtered fail-closed (a hidden op returns
`unknown_tool` even when called by name). `--surface full` (the default)
exposes every operation, verbs included. Why default full: verbs is for
agents and quickstarts; full preserves existing advanced tooling. Persist a
default with `gbrain config set mcp_surface verbs`.

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

Resolution (frozen precedence): alias > exact title > slug/slug-suffix; ties
break on most-recently-touched. Multi-hit ⇒ best match's card + runners-up in
`suggestions`. Miss ⇒ `found: false` + keyword near-misses with
`create_safety` hints.

Response: `{ protocol_version, found, latency_ms, card?, suggestions? }`.
Card: `{ entity{slug,title,type}, aka[], summary, last_touched{updated_at,
last_retrieved_at, last_timeline_date}, open_threads[], edges[],
backlink_count, active_fact_count }`.

- `summary` passes the same privacy fences as `get_page` (takes + private
  facts stripped); remote callers never see private facts in the card.
- `open_threads` (best-effort in v1): active commitment-kind facts + timeline
  entries from the last 90 days, capped at 3.
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

### forget(id, reason?) — write

Expire a fact by its opaque string id (from `remember` or
`recall.facts[].fact_id` — never a page slug). Idempotent: re-forgetting an
already-expired fact returns `expired: false` (success); unknown id ⇒
`not_found`. Facts are expired with an audit trail, never deleted.

Response: `{ id, expired, reason, protocol_version }`.

## Error contract (uniform across all five verbs)

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
real tokens. The fixture set ships as data
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
