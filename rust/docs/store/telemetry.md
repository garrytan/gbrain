# The brain store: Telemetry

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Search telemetry (`search_telemetry`): the per-day counters the search telemetry flush
(`src/core/search/telemetry.ts`) adds to, read by `gbrain search stats` and the search tune advisor. The MCP
request log (`mcp_request_log`): one row per MCP request, tools/list, webhook, surface change, access admin action
and memory setting change, read by `gbrain auth` usage and doctor. Its tally (`mcp_request_log_rollup`): the
per-token count of the rows the retention prune (`src/core/mcp-request-log-retention.ts`) removed. The chat
usage ledger (`chat_usage_log`): one row per chat call the gateway sink (`src/core/ai/chat-usage.ts`) records,
read by `get_usage`. The TypeScript statements are in `src/core/engine-sql/telemetry.ts` and
`src/core/engine-sql/chat-usage.ts`; the store modules are `rust/crates/gbrain-store/src/telemetry.rs` and
`rust/crates/gbrain-store/src/chat_usage.rs`.

Keys: every record starts with the family tag `a` (`keys::TELEMETRY`) and the table's sub-tag.

- `a 0x01 <date> 0x00 <mode> 0x00 <intent>` holds one search telemetry row; the text parts are the table's
  primary key `(date, mode, intent)` and hold no NUL byte.
- `a 0x02 <created_at BE8, sign bit flipped> <id BE8>` holds one request log row. Key order is `created_at`
  order, ties by id; the id comes from the `next_mcp_request_id` counter, as `SERIAL` does.
- `a 0x03 <token_name>` holds one tally row. A NULL token counts under `''`, as the prune's
  `COALESCE(token_name, '')` does.
- `a 0x0B <created_at BE8, sign bit flipped> <id BE8>` holds one chat usage ledger row
  (`keys::TELEMETRY_CHAT_USAGE`, a reviewed key reservation). Key order is `created_at` order, ties by id; the id
  comes from the `next_chat_usage_id` counter.

The other sub-tags of `a` (retrieval feedback, budget ledger) have no records yet. No table has a source or
page column, so page and source deletes never touch them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.recordSearchTelemetry(bucket)` | `null`. Adds each counter and `sum_rank1_score` to the `(date, mode, intent)` row and sets `last_seen` to now, or inserts the row with `first_seen = last_seen = now`. Checks run in Postgres order: a counter that is not a whole `int4` is `invalid_argument` (`invalid input syntax for type integer` / `out of range`), then a null column is `constraint_violation` in column order, then a sum that leaves `int4` is `invalid_argument` (`integer out of range`) and writes nothing. A NUL byte is `invalid_argument` | `recordSearchTelemetry` |
| `brain.readSearchStats(cutoffDate)` | one row per `(mode, intent)` over the rows with `date >= cutoffDate`: every counter summed as an integer, `sum_rank1_score` as a float, `first_seen` = the smallest `first_seen` and `last_seen` = the largest `last_seen`, both as `timestamptz::text` (`2026-11-18 07:46:03.336+00`). A null cutoff matches no row. A sum outside `int4` is `invalid_argument`, as `SUM(..)::int` is | `readSearchStats` |
| `brain.logMcpRequest(row)` | `null`. Appends one request log row with the next id; `created_at` is ISO text, or null for now. Checks run in Postgres order: a `latency_ms` that is not a whole `int4`, a `created_at` that is not ISO text, or a NUL in a text field or `params` is `invalid_argument`; then a null `operation` or `status` is `constraint_violation` naming `mcp_request_log` | `logMcpRequest` |
| `brain.readMcpLogPruneCutoff(days)` | `{ rollup_present: true, cutoff }`: the tally always exists in the store; `cutoff` is `now - days` as ISO text, null for a null day count. A day count that is not a whole `int4` is `invalid_argument` | `readMcpLogPruneCutoff` |
| `brain.pruneMcpRequestLogBatch(cutoff, keepOperations, limit)` | `{ deleted, newest }`. In one write, deletes the oldest `limit` rows created before `cutoff` whose operation is not in `keepOperations` and adds them to the tally: `requests` grows by the count, `last_used_at` and `pruned_through` take the newest deleted `created_at` (`GREATEST`, which skips a NULL). `newest` is that time as ISO text, null when nothing was deleted. A null cutoff, a null list or a list holding a null takes nothing (`<> ALL` is never true); a null limit takes every row; a negative or fractional limit is `invalid_argument` | `pruneMcpRequestLogBatch` |
| `brain.readClientOpUsage(days)` | one `{ token_name, operation, n, last_seen }` row per token and operation over the rows created after `now - days` with a token and status `success`, `success_with_warnings` or `accepted_pending`; `n` is an integer, `last_seen` the newest `created_at` as ISO text. A null day count matches no row | `readClientOpUsage` |
| `brain.readMcpRollupPrunedBefore()` | `{ pruned_before, now }`: the newest `pruned_through` of the tally (null when nothing was pruned) and the store clock, as ISO text | `readMcpRollupPrunedBefore` |
| `brain.logChatUsage(row)` | `null`. Appends one ledger row with the next id; `created_at` is ISO text, or null for now. Checks run in Postgres order: a NUL byte is `invalid_argument`, a token count that is not a whole `int4` is `invalid_argument`, a bad `created_at` is `invalid_argument`, then a null `model` or token count is `constraint_violation` (`null value in column "<column>"`) | `logChatUsage` |
| `brain.readChatUsage(days)` | `{ rows, logged_since }`: one `{ model, phase, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, unpriced_calls }` row per `(model, phase)` over the rows created on or after `now - days`, ordered by summed cost descending (null last), then model and phase in byte order with a null phase first. `cost_usd` is null when no call in the group is priced. `logged_since` is the first `created_at` of the whole ledger as timestamp text (null when empty) | `readChatUsage` |
| `brain.readMcpLifetimeUsage(tokenNames)` | one `{ token_name, requests, last_used_at }` row per asked token that has log rows or a tally row, in token byte order: `requests` is the token's request log rows (every status and operation) plus its tally `requests`, `last_used_at` the newest of the newest `created_at` and the tally's `last_used_at`, as ISO text. A null list or a null name matches nothing; a NULL-token log row never matches, and the tally's `''` row matches only an asked `''`. A NUL in a name is `invalid_argument`; a sum past `int8` is `invalid_argument` (`integer out of range`) | `readMcpLifetimeUsage` |

The TypeScript members turn each ISO time (`cutoff`, `newest`, `last_seen`, `pruned_before`, `now`, `last_used_at`) into a
`Date`, as PGLite's driver reads a `timestamptz`, and pass a `Date` `created_at` as ISO text.

Differences from PGLite:

- `readSearchStats`: PGLite returns the groups in no set order; the store returns them in `(mode, intent)`
  byte order. Every caller keys the rows by mode and intent.
- `date >= cutoffDate` compares bytes (the C collation). The flush and every reader write and pass
  `YYYY-MM-DD` dates, where byte order and every collation agree.
- Timestamp text uses UTC (`+00`), the session time zone PGLite runs in. A Postgres brain whose session
  time zone is not UTC prints another offset; callers parse the text, so the instant is the same.
- `now()` is the store clock (`Env::now_micros`, microseconds); PGLite's clock has millisecond precision,
  so its fractions are shorter. Both are trimmed the same way.
- The float sum adds rows in key order; Postgres adds them in scan order. The sums agree within 1e-6.

- `readClientOpUsage`: PGLite returns the groups in no set order; the store returns them in
  `(token_name, operation)` byte order. Every caller keys the rows.
- `pruneMcpRequestLogBatch` breaks a `created_at` tie by id; Postgres takes tied rows in index scan order.
  `FOR UPDATE SKIP LOCKED` has no store meaning: the store has one writer, so two prunes never overlap.
- `logMcpRequest` reads `created_at` as ISO text only (`2026-11-18T07:46:03.336Z`, up to six fraction digits);
  Postgres also reads other `timestamptz` spellings. Every caller passes a `Date` or nothing.
- `readMcpLogPruneCutoff` always answers `rollup_present: true`: a store brain has no migration that could be
  missing the tally.
- `readMcpLifetimeUsage` always adds the tally, for the same reason; the TypeScript statement reads the log alone
  when the tally table is missing. Both return token byte order (`ORDER BY token_name COLLATE "C"`).

- `readChatUsage` token sums are floats in the store; Postgres sums `int4` as `bigint`, which the TypeScript
  statement reads through `Number()`. The values agree for every sum below 2^53.

## Known gaps

- `readMcpLifetimeUsage` sorts by `token_name COLLATE "C"`; no test tells that from the database default, because
  both test databases sort in byte order (PGLite `C`, the local Postgres `C.UTF-8`).

The legacy HTTP transport (`src/mcp/http-transport.ts`, `logRequest`) writes its request
log row through `logMcpRequest`, and `lifetimeUsage` (`src/core/mcp-request-log-retention.ts`) reads through
`readMcpLifetimeUsage`, which also absorbs the tally-table probe `rollupTablePresent` used to make.
