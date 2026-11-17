# The brain store: Eval capture

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Captured eval candidates (`eval_candidates`) and capture failures (`eval_capture_failures`). Both are
small logs; the list methods read the whole table and sort it. Timestamps cross the binding as ISO
strings (`Date#toISOString` form is accepted); the TypeScript members turn them into `Date`s.

Keys: `Z 0x01 <id u64 BE>` holds a candidate, `Z 0x02 <id u64 BE>` a failure. Ids come from the
counters `M next_eval_candidate_id` and `M next_eval_failure_id`; a deleted row's id is never reused
and a refused insert takes no id. Page deletes do not cascade here.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.logEvalCandidate(input)` | the new id. `retrieved_slugs` keeps, in order, only slugs a page of `source_ids` holds (any source when `source_ids` is empty; soft-deleted pages count; null elements drop). `constraint_violation` for a `NOT NULL` or `CHECK` failure (`tool_name` in `query`/`search`, `query` at most 51200 characters, `detail`/`detail_resolved` in `low`/`medium`/`high`); `invalid_argument` for a NUL byte or a number that is not an `int4` | `logEvalCandidate` |
| `brain.listEvalCandidates({ since?, limit?, tool? }?)` | `EvalCandidate[]` with every column (`as_of_ts`, `schema_pack_per_source` and the salience/recency columns are null), `created_at >= since` (epoch when absent), `tool_name = tool` when given, `created_at DESC, id DESC`. `limit` is 1000 when absent, not finite or not positive, else `min(floor(limit), 100000)` | `listEvalCandidates` |
| `brain.deleteEvalCandidatesBefore(date)` | number of rows with `created_at < date`, deleted | `deleteEvalCandidatesBefore` |
| `brain.logEvalCaptureFailure(reason)` | `null`; `constraint_violation` for a reason outside `db_down`, `rls_reject`, `check_violation`, `scrubber_exception`, `other` | `logEvalCaptureFailure` |
| `brain.listEvalCaptureFailures({ since? }?)` | `{ id, ts, reason }[]`, `ts >= since`, newest first | `listEvalCaptureFailures` |

Differences from PGLite:

- `listEvalCaptureFailures`: Postgres orders by `ts DESC` alone, so equal stamps come in no fixed order.
  The store breaks ties by `id DESC`.

A `facts/<id>` slug (`^facts/[0-9]{1,18}$`) is kept while fact row `id` exists in one of the candidate's
sources (any source when `source_ids` is empty), as PGLite does. An expired, superseded or consolidated
fact, or one whose page is soft-deleted, still counts; only a deleted row is gone
(`facts::fact_exists`). A `source_ids` list of only nulls matches no fact.

For page_ops: `eval_capture::remove_retrieved_slugs(tx, source_id, slugs) -> u64` is the
`eval_candidates.retrieved_slugs` scrub of PGLite's `scrubPurgedSlugs`. Call it in the delete's
transaction after the pages are gone. It touches candidates whose `source_ids` contain `source_id`, drops
each slug in `slugs` unless a page by that name lives in another source the candidate covers, keeps the
order of the rest, and returns the number of candidates changed. A candidate with empty `source_ids` is
never touched, as in PGLite.
