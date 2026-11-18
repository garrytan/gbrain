# The brain store: Telemetry

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Search telemetry (`search_telemetry`): the per-day counters the search telemetry flush
(`src/core/search/telemetry.ts`) adds to, read by `gbrain search stats` and the search tune advisor. The
TypeScript statements are in `src/core/engine-sql/telemetry.ts`; the store module is
`rust/crates/gbrain-store/src/telemetry.rs`.

Keys: every record starts with the family tag `a` (`keys::TELEMETRY`) and the table's sub-tag.
`a 0x01 <date> 0x00 <mode> 0x00 <intent>` holds one search telemetry row; the text parts are the
table's primary key `(date, mode, intent)` and hold no NUL byte. The other sub-tags of `a` have no
records yet (see "Not served"). The table has no source or page column, so page and source deletes
never touch it.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.recordSearchTelemetry(bucket)` | `null`. Adds each counter and `sum_rank1_score` to the `(date, mode, intent)` row and sets `last_seen` to now, or inserts the row with `first_seen = last_seen = now`. Checks run in Postgres order: a counter that is not a whole `int4` is `invalid_argument` (`invalid input syntax for type integer` / `out of range`), then a null column is `constraint_violation` in column order, then a sum that leaves `int4` is `invalid_argument` (`integer out of range`) and writes nothing. A NUL byte is `invalid_argument` | `recordSearchTelemetry` |
| `brain.readSearchStats(cutoffDate)` | one row per `(mode, intent)` over the rows with `date >= cutoffDate`: every counter summed as an integer, `sum_rank1_score` as a float, `first_seen` = the smallest `first_seen` and `last_seen` = the largest `last_seen`, both as `timestamptz::text` (`2026-11-18 07:46:03.336+00`). A null cutoff matches no row. A sum outside `int4` is `invalid_argument`, as `SUM(..)::int` is | `readSearchStats` |

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

## Not served

`readClientOpUsage` and `readMcpRollupPrunedBefore` (the `telemetry` capability's MCP usage reads) are
not served: no typed member writes `mcp_request_log` or prunes it into `mcp_request_log_rollup` yet, so
the request log rows would never reach the store. Until those writers are typed, both refuse with
`engine_capability_missing` naming `telemetry`, and the Rust engine does not report `telemetry`.

## Follow-ups

- telemetry-mcp-request-log-writers: type the `mcp_request_log` insert (the surface, access-admin,
  webhook and MCP request audit rows, the memory writeback setting audit) and the retention prune, then
  serve the two MCP usage reads under sub-tags `0x02` and `0x03`. Done when all four `telemetry` members
  are served and `test/engine-parity/telemetry.test.ts` reports `telemetry` on the Rust arm.

## Known gaps

- `readMcpLifetimeUsage` sorts by `token_name COLLATE "C"`; no test tells that from the database default, because
  both test databases sort in byte order (PGLite `C`, the local Postgres `C.UTF-8`).
