# Eval capture — NDJSON schema reference

**Status:** stable from v0.21.0. Schema versioning via `schema_version`
on every row; additive changes increment the minor version; removals
are breaking-schema-v2.

**Audience:** downstream consumers (primarily the sibling
[gbrain-evals](https://github.com/garrytan/gbrain-evals) repo) that
replay captured real-world queries as a BrainBench-Real fixture.

## The pipeline

```
MCP / CLI / subagent tool-bridge caller
     │
     ▼
src/core/operations.ts — query + search op handlers
     │
     │ (hybridSearch or searchKeyword)
     │
     ▼
{results, meta: HybridSearchMeta}                 ┌── captureEvalCandidate
     │                                             │    (fire-and-forget)
     ▼                                             │
return to caller                                   ▼
                                            scrubPii(query) ←── src/core/eval-capture-scrub.ts
                                                   │
                                                   ▼
                                           buildEvalCandidateInput
                                                   │
                                                   ▼
                                           engine.logEvalCandidate
                                                   │
                                    ┌──────────────┴──────────────┐
                                    │ success                     │ fail
                                    ▼                             ▼
                                INSERT into eval_candidates    engine.logEvalCaptureFailure
                                                                 (reason: db_down | rls_reject |
                                                                  check_violation |
                                                                  scrubber_exception | other)
```

## `gbrain eval export` — the consumer contract

```sh
gbrain eval export [--since DUR] [--limit N] [--tool query|search]
```

Emits NDJSON to **stdout**. One JSON object per `\n`-terminated line.
stderr receives progress heartbeats. Every line starts with
`"schema_version": 1` so a forward-compat parser can fail loudly on
schema v2 instead of silently misparsing.

Typical usage from gbrain-evals:

```sh
# Snapshot the last week of real traffic for replay
gbrain eval export --since 7d > brainbench-real.ndjson
```

```sh
# Stream through jq for ad-hoc analysis
gbrain eval export --tool query | jq -c 'select(.latency_ms > 500)'
```

## Row schema (v1)

Every exported row has this shape. Field order in JSON output is not
guaranteed; consumers MUST key by name, not position.

| Field | Type | Notes |
|---|---|---|
| `schema_version` | number | Always `1` on v1 rows. Forward-compat gate. |
| `id` | number | Autoincrement primary key. Stable across exports. |
| `tool_name` | `"query"` \| `"search"` | Which MCP operation captured this row. |
| `query` | string | **Already PII-scrubbed** by `scrubPii` unless `eval.scrub_pii: false`. Emails / phones / SSN / Luhn-verified credit cards / JWTs / bearer tokens replaced with `[REDACTED]`. Max length 50KB (CHECK-enforced). |
| `retrieved_slugs` | string[] | Deduplicated slugs that came back in `SearchResult[]`. |
| `retrieved_chunk_ids` | number[] | Every chunk id in result order (duplicates preserved — one per hit). |
| `source_ids` | string[] | Distinct `sources.id` values across the result set (v0.18 multi-source). Empty for pre-v0.18 rows that lacked the column. |
| `expand_enabled` | boolean \| null | Whether the caller **requested** Haiku expansion. `null` for `search` (no expansion concept). |
| `detail` | `"low"` \| `"medium"` \| `"high"` \| null | Detail level the caller **requested**. `null` when omitted. |
| `detail_resolved` | `"low"` \| `"medium"` \| `"high"` \| null | What `hybridSearch` **actually used** after auto-detect. `null` when neither caller nor heuristic classified. |
| `vector_enabled` | boolean | True iff vector search actually ran. `false` when `OPENAI_API_KEY` was missing or the embed call failed. **Replay MUST respect this** — rows with `false` only exercised the keyword path. |
| `expansion_applied` | boolean | True iff Haiku expansion actually produced variants (not just "was requested"). |
| `latency_ms` | number | Wall-clock duration of the op handler (includes capture itself — negligible since it's fire-and-forget). |
| `remote` | boolean | `true` for MCP callers (untrusted), `false` for local CLI. Partitions "real agent traffic" from "operator probing." |
| `job_id` | number \| null | `OperationContext.jobId` when the caller was a subagent tool-bridge. Null for MCP + CLI. |
| `subagent_id` | number \| null | `OperationContext.subagentId` for subagent-owned runs. |
| `created_at` | string (ISO 8601) | UTC timestamp of insert. |

## Ordering + determinism

`listEvalCandidates` orders by `created_at DESC, id DESC`. Same-
millisecond inserts tie on `created_at`; `id DESC` is the stable
tiebreaker. Replay tools can consume rows in order and assume:
- no duplicate rows across calls with non-overlapping `--since` windows
- no missed rows across calls that chain `--since` windows (window end
  of run 1 is the strict upper bound, not a soft cursor)

## Schema versioning promise

- **v1 (shipped v0.21.0)** — this document. All fields listed above.
- **Additive changes** increment gbrain minor version (v0.25.0, v0.23.0
  …) and ship with new optional fields. Consumers keyed on known fields
  ignore unknown keys and keep working.
- **Breaking changes** (rename, type change, removal) increment
  `schema_version` to 2. Consumers MUST branch on `schema_version` to
  stay compatible.

## `eval_capture_failures` — companion audit table

Not exported by `gbrain eval export`. Surfaced via `gbrain doctor`:

```sh
gbrain doctor   # warns when failures in last 24h > 0
```

Reason enum (stable): `db_down` | `rls_reject` | `check_violation` |
`scrubber_exception` | `other`. Cross-process visibility is the whole
point — `gbrain doctor` runs in its own process and reads the table
directly, so in-process counters wouldn't work.

## Config + CONTRIBUTOR_MODE

Capture is **off by default** as of v0.25.0 (was on for everyone in
earlier drafts). Two paths to turn it on:

**Path A — env var (contributor opt-in, the common case):**

```bash
export GBRAIN_CONTRIBUTOR_MODE=1     # in ~/.zshrc or ~/.bashrc
```

**Path B — explicit config (`~/.gbrain/config.json`, file-plane only):**

```json
{
  "engine": "postgres",
  "database_url": "...",
  "eval": {
    "capture": true,
    "scrub_pii": true
  }
}
```

Resolution order (most explicit wins):

1. `eval.capture: true` in config → on
2. `eval.capture: false` in config → off (overrides CONTRIBUTOR_MODE=1)
3. `GBRAIN_CONTRIBUTOR_MODE === '1'` → on
4. otherwise → off

`scrub_pii` defaults to `true` independent of capture. Set
`eval.scrub_pii: false` to preserve raw query text (only if you control
the brain's distribution).

`gbrain config set eval.capture false` does **not** work — that
command writes the DB-plane config, and the MCP server reads the
file-plane. Edit the JSON directly or use the env var.
