# The brain store: Contradiction probe runs and judge cache

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The contradiction probe stores one record per run and caches each judge verdict, under key tag `Q`.
It ports the `eval_contradictions_runs` and `eval_contradictions_cache` reads and writes of
`src/core/engine-sql/contradictions.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.writeContradictionsRun(row)` | `true` when written, `false` when `run_id` already exists (nothing changes). A missing field is `constraint_violation`; `ran_at = now` | `writeContradictionsRun` |
| `brain.loadContradictionsTrend(days)` | the runs with `ran_at` at or after `now - max(0, days) days`, newest first: `{ run_id, ran_at, judge_model, queries_evaluated, queries_with_contradiction, total_contradictions_flagged, wilson_ci_lower, wilson_ci_upper, judge_errors_total, cost_usd_total, duration_ms, source_tier_breakdown, report_json }`. A NaN `days` is `invalid_argument` | `loadContradictionsTrend` |
| `brain.getContradictionCacheEntry(key)` | the verdict of a live entry (`expires_at > now`), else `null`. The key has five parts: `chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy`; a missing part resolves `null` | `getContradictionCacheEntry` |
| `brain.putContradictionCacheEntry(entry)` | `null`; an upsert with `expires_at = now + max(60, ttl_seconds ?? 30 days)`. A missing verdict is `constraint_violation`; a non-finite TTL is `invalid_argument` | `putContradictionCacheEntry` |
| `brain.sweepContradictionCache()` | the number of entries deleted, those with `expires_at <= now` | `sweepContradictionCache` |

Numbers follow the column types: the `INTEGER` fields take only an integer in int4 range
(`invalid_argument` otherwise), and the `REAL` fields (`wilson_ci_lower`, `wilson_ci_upper`,
`cost_usd_total`) are rounded to `f32` and read back as the shortest decimal of that `f32`.

As in PGLite, the cache's `expires_at` and the trend's cutoff are millisecond times (they come from
`Date.now()` there); `ran_at` and the cache's `created_at` are microsecond store times. JSON values read
back in jsonb key order. No key part may hold a NUL byte (`invalid_argument`).

## Edge-contradiction cycle and eval reads (`src/core/engine-sql/contradictions-cycle.ts`)

Seventeen members for the statements the edge-contradiction cycle (`src/core/cycle/edge-contradictions.ts`), the eval
scoped read (`src/core/eval-contradictions/scoped-read.ts`), the cost prompt (`cost-prompt.ts`) and the suspected-contradictions
eval (`src/commands/eval-suspected-contradictions.ts`) ran as raw SQL.

`listLinkContexts` is served: `Store::list_link_contexts` (`gbrain-store/src/contradictions.rs`) reads the link records
that leave the page (`links::out_links`), keeps those to the target page with the link type and a non-empty context, and
answers the first three distinct contexts in byte order. The SQL has no `ORDER BY`, so with more than three distinct
contexts the three Postgres keeps are its own choice; the edge phase quotes them as evidence and depends on no order.

The twelve edge members are served: the proposal ledger, the candidate scan and the closure check live in
`gbrain-store/src/edge_proposals.rs` (see `edge_proposals.md`). Their capability in `members.ts` stays `contradictions`.

`readLastContradictionsPromptVersion` is served: `Store::read_last_contradictions_prompt_version` reads the run index
by `ran_at` in reverse and answers the newest run's prompt version, null before any run. Runs that tie on `ran_at` go to
the largest `run_id` in byte order; Postgres names no order for such ties. With it, every `contradictions` member is
served, so the Rust engine reports `contradictions` (`test/rust-engine-capability-classes.test.ts`).

The other three are not served on Rust today: each is absent from `store-members/*`, so it refuses with
`engine_capability_missing` naming the member. Their capability in `members.ts` is `chunks` for `listLiveChunksByIds`,
`takes` for `listLiveTakesByIds` and `eval_capture` for `listEvalCandidateQueries`. The caller sees the refusal; no
member changes behaviour. What the store would need to serve them:

| Members | Reads or writes | The store would need |
| --- | --- | --- |
| `listLiveChunksByIds`, `listLiveTakesByIds` | live chunks and active takes by id under the caller's page policy, the holder allow-list and a trust floor | the caller's page policy applied to the owning page; the take holder allow-list; the projection-eligibility floor |
| `listEvalCandidateQueries` | recent eval-capture queries | the capture record scan, newest first |

The policy and floor text are Postgres text only; the store reads the typed arguments, never the statement.
