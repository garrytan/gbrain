# The brain store: the subagent transcript and tool ledger

Part of the Minion jobs family ([jobs.md](jobs.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

A subagent job persists one `subagent_messages` row per model turn and one `subagent_tool_executions` row per tool call. The
subagent handler, the oneshot runner, crash replay, the transcript views, the `get_page` read budget and the dream cycle's
provenance reads all use them. The SQL lives once in `src/core/engine-sql/jobs-subagent.ts` (PGLite and PostgreSQL both
call it); the Rust store serves the same 17 members, and every row it writes is the row the SQL writes. The parity file is
`test/engine-parity/jobs-subagent.test.ts`.

## Members

| Member | Returns |
| --- | --- |
| `brain.listSubagentMessages(jobId, { last? })` | the job's messages by `message_idx`; with `last`, only the newest (an empty list when there is none) |
| `brain.countSubagentMessages(jobId)` | how many messages the job has |
| `brain.insertSubagentMessage(jobId, message)` | nothing; a message already at the `message_idx` stays as it is (first writer wins) |
| `brain.listSubagentToolExecutions(jobId, 'replay' \| 'id')` | the job's tool rows: `replay` is `(message_idx, ordinal with NULL as 0, id)`, `id` is insertion order |
| `brain.hasSubagentToolExecution(jobId, { status?, toolUseIdPrefix? })` | whether a row of that status whose `tool_use_id` is `LIKE prefix \|\| '%'` exists |
| `brain.listSubagentWriteOutcomes(jobId, prefix?)` | `{ status, error, output }` of the `brain_put_page` rows, by id, optionally scoped to a `LIKE` prefix |
| `brain.listSubagentOneshotLedger(jobId, prefix)` | the rows under a `LIKE` prefix, by id, with `slug`, `content`, `request_id`, `skip_reason`, `batch_id` read from the input as text |
| `brain.summarizeSubagentToolExecutions(jobIds, { toolName, status })` | `{ count, output_bytes }`: the bytes are the length of each output's `jsonb` text (a SQL NULL output has none) |
| `brain.listSubagentPutPageSlugs(jobIds)` | the distinct slugs of completed `brain_put_page` calls, bytewise ascending, a call without a slug (null) last |
| `brain.listSubagentPutPageWrites(jobIds)` | `{ job_id, slug, started_at }` of each completed call, by id |
| `brain.listSubagentRetainedPutPages(jobIds)` | the completed calls whose output `state` is `committed`, with the job's idempotency key (`job_key`), by id |
| `brain.listSubagentStagedPages(jobId)` | per slug, the last completed call whose output `status` is `staged`, with its markdown (output `content`, else input `content`); slugs bytewise ascending, null last |
| `brain.listSubagentTimelineAppendCalls(jobIds, sourceId)` | the `brain_add_timeline_entry` calls whose request id names a committed, `ok` `add_timeline_entry` request of the source: `{ request_id, slug, input }`, by call id |
| `brain.recordSubagentToolExecutions(jobId, rows, { legacyGuard? })` | nothing; banks the rows at their ordinals in one transaction. A position that already has a row keeps it. With `legacyGuard`, a row is also skipped when a legacy (NULL ordinal) row of the same turn and tool id exists |
| `brain.startSubagentToolExecution(jobId, row)` | the stable id of the pending `schema_version` 2 row at the position: the one it wrote, or, when the position was taken, that row's own (null for a legacy row) |
| `brain.completeSubagentToolExecution(target, output)` | how many rows it settled |
| `brain.failSubagentToolExecution(target, error, fallback?)` | how many rows it changed |

A settle `target` is `{ gbrainToolUseId }` (every row with that stable id, whatever its status) or `{ jobId, messageIdx, ordinal,
toolUseId }` (exactly one row: the call's own ordinal first, then a legacy NULL one, then the lower id; never a row already
complete). With a `fallback` (a positional target), a failure at a position with no settleable row inserts a failed row, unless
the position holds another tool id or a complete row, which it leaves alone.

## Records and keys

The keys sit under `keys::JOBS` (`m`) with sub-tags `0x18..=0x1C`; the layout is the module comment of
`rust/crates/gbrain-store/src/jobs/subagent.rs`:

- `0x18 job message_idx`: a message (ids from the `subagent_message` sequence).
- `0x19 job id`: a tool row (ids from the `subagent_tool` sequence).
- `0x1A job message_idx ordinal -> id`: the unique position index; legacy rows are not in it.
- `0x1B uuid_text \0 job id`: rows by stable id (not unique).
- `0x1C job message_idx id`: the legacy rows of a turn.

A tool `output` is stored as JSON text so a JSON null stays different from a SQL NULL. A stable id is kept lowercase and
hyphenated; the 32-hex form is accepted. The LIKE matcher is the store's own (`%`, `_`, `\` escape).

Deleting a job (`deleteTerminalJob` and the sweeps that delete) removes its messages and tool rows and their index records, as
`ON DELETE CASCADE` does. A write for a job that does not exist, a role other than user/assistant, a status other than
pending/complete/failed, a stable id that is not a UUID, text that is not JSON, or an integer outside 32 bits is refused as
the SQL refuses it, and writes nothing.

## Differences from PGLite and PostgreSQL

- Where the old SQL had no `ORDER BY`, the members order by `id`; the slug reads sort bytewise (`COLLATE "C"` on PostgreSQL).
  That pins an order the callers never relied on; it is a change on the SQL engines too.
- A string slug or request id that is not JSON (a double-encoded pre-fix input) refuses the read, as the `::jsonb` cast does.
- JSON numbers lose their trailing zeros and exponent text on the Rust path (`1.50` reads back `1.5`), because the store's JSON
  has no arbitrary precision. This also moves the `output_bytes` sum by those characters.
- Ids are gapless on the Rust store; a PostgreSQL sequence skips a value on a conflicting insert.
- A malformed JSON argument is refused up front on the Rust path even when the settle would match no row.
- `committedRequestsFor` in `src/core/cycle/synthesize-postprocess.ts` reads `persistence_requests` by `executeRaw` and is not part
  of this group.
- `gbrain repair-jsonb` and the doctor's JSONB-shape check still read these tables with `executeRaw`; the Rust engine refuses them.
