# The brain store: Persistence journal rows

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The persistence coordinator (`src/core/persistence/`) stays TypeScript. This family stores the rows
it reads and writes, so the typed journal members of `src/core/engine-sql/persistence-journal.ts` and
`persistence-claims.ts` have the same answer on a Rust brain as on PGLite. The code is
`crates/gbrain-store/src/persistence.rs`; the native write path (`submitPageMutation`) is in
[journal.md](journal.md).

## Keys

| Key | Record |
| --- | --- |
| `J <principal kind> 0x00 <principal id> 0x00 <request id>` | one `persistence_requests` row (`journal::RequestRecord`), JSON (journal.rs) |
| `j <journal id>` | the request key of that row (journal.rs) |
| `W <writer id>` | one `persistence_local_writers` row (journal.rs) |
| `d 0x01 <counter key>` | one `persistence_counters` row, JSON |
| `d 0x02 <op> 0x00 <fingerprint>` | one housekeeping `op_checkpoints` row, JSON |

A counter key is the text of `persistence_counters.key` (`brain`, `principal:<kind>:<id>`). A request
row that `insertWriteRequest` stored keeps every `persistence_requests` column: the columns the native
journal reads are named fields, the others are in the record's `extra` map with their table defaults.
A record the native write path stored reads back with those defaults filled in.

## Methods

Each method is one store write transaction (or one read). The row locks Postgres takes for these
statements (`FOR SHARE`, `FOR UPDATE`, `SKIP LOCKED`), the advisory locks and the page write guards are
no-ops: the store runs one write transaction at a time, so no read overlaps a write.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.lockPersistenceCounters(keys)` | the counter rows `{ key, outstanding_count, intent_bytes, lifetime_ids, terminal_bytes }`, sorted by key; a missing row is created at zero | `lockPersistenceCounters` |
| `brain.insertWriteRequest(row)` | the stored `WriteRequest`. It charges each counter (one outstanding request, its intent bytes, one lifetime id, its terminal reservation) in the same write. `constraint_violation` for a principal kind, state, target kind or protocol version the table refuses, a null slug, a worktree or refresh id (this engine keeps no worktrees), or a request id the principal already used | `insertWriteRequest` |
| `brain.readWriteRequest({ kind, id }, requestId)` | the `WriteRequest` or `null` | `readWriteRequest` |
| `brain.readWriteRequestById(id)` | the `WriteRequest` or `null` | `readWriteRequestById`, `lockWriteRequest` |
| `brain.stampWriteClaim({ id, token, leaseMs, phaseJson })` | the claimed row with `passed_sync` and `seen_sequence`, or `null` when the refresh barrier holds it | `stampWriteClaim` |
| `brain.completeWriteRow(completion)` | the ended row (with `purge_has_facts`, `purge_has_pages` when `probePurges`), or `null` when the effects do not fit the reservation. Releases the counters; a terminal counter shorter than the release is clamped to zero and counted in config `persistence.true_up.clamped`. A completion that would take a counter below zero changes nothing and rejects with `constraint_violation` | `completeWriteRow` |
| `brain.renewWriteClaim({ id, token, leaseMs, phaseJson })` | `true` when the claim is still `running` under that token; the lease is extended and the phase replaced when one is given | `renewWriteClaim` |
| `brain.expireStaleWriteClaims({ hostId, charge, deadOwners })` | the number of claims returned to `queued`: an expired lease, or a phase owner in `deadOwners` (`pid:nonce:start`), with publication not started; at most 100, oldest first. `charge` counts one preparation attempt for a claim that expired while preparing | `expireStaleWriteClaims` |
| `brain.hasClaimableWrite({ excludeRoots, priority })` | whether a claim would find a row now. `priority` `null` reads config `sync.foreground_priority` (on unless `0` or `false`) | `hasClaimableWrite` |
| `brain.readSourceMembership(sourceId)` | `{ incarnation, archived }` or `null` | `readSourceMembership`, `readLedgerSource` |

Rows have a null `worktree_id`, so the worktree terms of the claim statements are answered as Postgres
answers them for a null worktree. `select_claimable_write` (the claim head read) exists in the store
but has no binding: `claimNextWrite` runs inside `transactionDirect`, which the Rust engine does not
serve yet.

## TypeScript members with no stored state

| Member | Answer | Why |
| --- | --- | --- |
| `findTopologyChanges(principalId, requestIds)` | `[]` | No topology change is recorded on this engine (no worktrees). |
| `readLedgerSource(sourceId, opts?)` | `{ incarnation, purgeEpoch: 0, coverage: null, purgesPossible: false }`; a batch adds `managedRows: [{ enabled: false }]` and `planModePrev: 'auto'` | Belief events and fact, take and page purges are written only through `executeRaw`, which this engine refuses. |
