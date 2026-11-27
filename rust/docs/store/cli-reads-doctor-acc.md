# The brain store: doctor reads, second set

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that `gbrain doctor` checks (access, token, OAuth, request log, decide, chronicle, feedback,
belief and volunteer checks) ran through `executeRaw`. PGLite and Postgres run the same SQL as before
(`src/core/engine-sql/doctor-acc.ts`; the text is pinned by `test/doctor-acc-sql.test.ts`). The TypeScript side is
`src/core/rust-engine/store-members/doctor-acc.ts`. Most members answer there, with no store call, because the Rust store
keeps none of the state they read; only the request-log reads are store methods
(`crates/gbrain-store/src/cli_reads/doctor_acc.rs`).

## Served by the store

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readMcpRequestLogBytes()` | the bytes of the request log's keys and records | `pg_total_relation_size('mcp_request_log')` |
| `brain.countMcpRequestLogRows(limit)` | the log's rows, counted up to `limit` | `count(*) FROM (SELECT 1 FROM mcp_request_log LIMIT $1)` |
| `brain.hasMcpLogRowsPastWindow(days, keepOperations)` | whether a row older than `days` days with an operation outside `keepOperations` exists | the `EXISTS` read before retention prunes |

The byte count differs from PGLite's in size, not meaning: PGLite reports the table's page footprint (32768 for an empty
log), the store reports 0. Doctor prints it in MB, so an empty log reads "0.0 MB" on both. `details.bytes` in the JSON
is engine-specific.

`hasMcpLogRowsPastWindow` follows `pruneMcpRequestLogBatch`: the cutoff is `now - days` (the day count read as an `int4`),
and rows are visited in `created_at` order, so the scan stops at the first row inside the window.

One read of the access checks is served from the page records as well (`crates/gbrain-store/src/cli_reads/doctor_acc.rs`):

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listReaderPages(updatedWithinDays)` | `[{ id, source_id, slug, readers, updated_at, updated_us, writer, prior_names_readers }]` for every live page whose frontmatter has a `readable_by` key (a JSON null counts), by source then slug in byte order; `updatedWithinDays` (null keeps all) keeps the pages written after `now - days`. `readers` is `gbrain_access_readers(frontmatter)` (`["!nobody"]` when no valid reader), `updated_at` is `timestamptz::text`, `writer` is `principal_kind:principal_id` of the revision receipt (null without one), `prior_names_readers` whether the newest stored version (snapshot time, then id) has a `readable_by` key (null with no version) | the page columns the three statements of `listMalformedReaderPages`, `listUnknownReaders` and `listRecentReaderNarrowings` read |

The members built from it answer in TypeScript: `listMalformedReaderPages` (the pages whose readers are `["!nobody"]`, with the total), `listUnknownReaders` (each named reader that is no member, a removed member, no group or a group with no member, classified as the SQL does, with its page count and first page; members and groups from `readAccessMembers` and `readAccessGroups`) and `listRecentReaderNarrowings` (pages written in the window whose newest earlier version named no readers, newest first).

## Credential reads

`listActiveAccessTokenRows`, `listActiveOauthClientRows` and `listAttestCredentialRows` read the store's token and
client records (`jobs/doctor_credentials.rs`). A token row names every `access_tokens` column, `token_hash` included, so
it has the same columns and values as the SQL engines' `SELECT *` (the parity case in
`test/engine-parity/doctor-acc.test.ts` compares every column); oldest first, a tie by id. A client row is
`ClientRecord::to_row`, every client not deleted, by client id in byte order. The attest rows are the tokens not revoked
and the clients not deleted with an attest actor: a token's `row` is `to_jsonb(t)` (times as `to_jsonb` text in a UTC
session), a client's is `to_jsonb(c) - 'client_secret_hash'` (`to_grant_json`), by kind then name in byte order, a tie by id.

## Answered in TypeScript

`listRawOnlyRules` reads each source's rules (`brain.listAccessRules`) and keeps those with `covers_derived` false, by (source, rule id) in byte order. `listAccessMemberRows` is `brain.readAccessMembers({ includeRemoved })`, by id with groups. `listAudienceMemberIds` and `listLabelledOnlyMemberIds` read the store's member records (`brain.readAccessMembers`): the enabled, unremoved members of kind `audience`, or with the labelled-only grant, by id in byte order.

An answer the store cannot contradict, because it keeps no such state:

| Members | Answer |
| --- | --- |
| `listPolicySourceIds`, `listBeliefCoveredSources` | no rows: no access state or coverage events are read from here |
| `listOauthClientAuthShapes`, `listDanglingFederatedReads`, `listPrivilegedDcrClients` | composed from the OAuth client rows the store serves (`listOauthClients`, `listOauthGrantAudit`, `listAllSources`): every client's auth shape, federated reads naming no source (an archived source is one), clients with grant revision 0 and no `register` audit row whose scope matches the pattern (`[[:space:]]` read as the POSIX space class). All byte order |
| `listVolunteerChannels` | served by the store from the push-context log ([volunteer-events.md](volunteer-events.md)) |
| `isAccessStateUnreadable` | false |
| `readKnowledgeRevisionNotNull` | true: the revision is always set |
| `readDriftSchema` | `current` |
| `originIndexPresent` | true for `pages_live_origin_key` (the one index the doctor asks about; the store has no SQL indexes to build), false for any other name |
| `listDecide*`, `readDecideDailySpend` | no rows, zero spend |
| `readPendingProposalSummary` | none pending |
| `readChronicleLedgerStats`, `readChronicleDuplicateEvents` | the available, empty tallies |
| `readFeedbackStatus` | zero counts |
| `listOrphanWorkspaceSources(suffix)` | composed from the source rows, page counts, fact health and live clients the store serves (a source a live client names as its source or a federated read is no orphan) |
| `listDriftLiveRows`, `listDriftVersionRows` | served by the store (`cli_reads/doctor_drift.rs`): the live pages of a source in id order (at most 500 after a cursor, or the one page at a slug) and the versions of the given pages. `req` and `kind` are the page's revision receipt (`revision_write_request_id`, `revision_principal_kind`) or the version's archived actor (`archived_write_request_id`, `archived_principal_kind`), and `remote` is `authority->>'remote'` of that journal request (text; null when the request or the key is absent), as the SQL's join answers. An unattributed write answers all three as null. A page scan costs O(pages) per batch |
