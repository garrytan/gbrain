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
