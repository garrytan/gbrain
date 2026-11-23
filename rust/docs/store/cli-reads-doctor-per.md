# The brain store: doctor persistence reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every
method here.

These are the statements the `gbrain doctor` persistence checks ran through `executeRaw` (capacity, request growth,
write stalls, compaction, counter drift, maintenance drift, publication refusals, local edit adoptions, parked and stale
effects, orphan bindings, unbound sources, purge mirror, derivation sweeps, writer versions, lost caller writes, and the
helpers under `src/core/persistence/` they call). PGLite and Postgres run the same SQL as before
(`src/core/engine-sql/doctor-persistence.ts`; the text is pinned by `test/doctor-persistence-sql.test.ts` and the
parity cases in `test/engine-parity/doctor-persistence.test.ts`). The store answers from the request journal and the
counters it keeps (`crates/gbrain-store/src/cli_reads/doctor_persistence.rs`). The TypeScript side is
`src/core/rust-engine/store-members/doctor-persistence.ts`.

Time arithmetic (`now() - interval`, `EXTRACT(EPOCH ...)`) stays in SQL on Postgres and PGLite and uses the store clock
here.

## Served from the store

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `listCapacityCounters()` | every `brain` and `principal:*` counter, text columns | `listCapacityCounters` |
| `listLifetimeCounters()` | `key`, `lifetime_ids` of the same counters | `listLifetimeCounters` |
| `countPersistenceRequestRows()` | the request rows, `{ rows: "N" }` | `countPersistenceRequestRows` |
| `readAdmissionSample(kind, id)` | admissions among the newest 10,000 requests (of one principal when given) created in the last 7 days, and the oldest | `readAdmissionSample` |
| `listOutstandingHolders(kind, id)` | the three sources holding the most outstanding slots, most stalled (ten minutes or older) first | `listOutstandingHolders` |
| `listRunningRequestStalls(maxClaimMs)` | the first 100 running requests with claim, age, root progress and queue behind | `listRunningRequestStalls` |
| `readMaxRequestSequence()` | the highest request sequence, text, or null | `readMaxRequestSequence` |
| `listRecentDriftReceiptSlugs(source, floor, message)` | distinct slugs with a `source_changed` receipt above `floor` (100), with their total | `listRecentDriftReceiptSlugs` |
| `listOlderDriftReceiptSlugs(source, floor, message)` | the same at or below `floor` (101) | `listOlderDriftReceiptSlugs` |
| `listRefusalBreakerRows(...)` | slugs refused at least `threshold` times in the window | `listRefusalBreakerRows` |
| `readCounterDrift(clampedKey)` | per counter: receipt rows and bytes, topology rows and bytes, the clamp tally | `readCounterDrift` |
| `readPublicationRefusals()` | refusals by origin: guard, trigger, opaque | `readPublicationRefusals` |
| `listRunningClaimOwners()` | running requests on no worktree with a claim owner | `listRunningClaimOwners` |
| `listLocalEditAdoptions()` | adopted local edits per source, with their paths | `listLocalEditAdoptions` |
| `listCallerRefusalRows(sources, operations)` | refused caller writes, with whether the revision is stale or the write unpinned | `listCallerRefusalRows` |
| `countCompactedCallerRefusals(sources, operations)` | the same refusals whose row was compacted | `countCompactedCallerRefusals` |
| `listRecentWriterVersions(days)` | admitter and consumer versions seen in the window | `listRecentWriterVersions` |
| `readPersistenceBrainIdText()` | the persistence identity as text (wraps `readPersistenceBrainId`) | `readPersistenceBrainIdText` |
| `listManagedRoots()` | each active source with a local path, as a managed root (wraps `listAllSources`) | `listManagedRoots` |

Where the statements differ from what Postgres does, the store follows the effect, not the plan:

- `countPersistenceRequestRows` ignores `estimate`: the store counts exactly (there is no planner to be cheaper than).
- `listOlderDriftReceiptSlugs` ignores `timeoutMs`: the store scans in memory, so there is no statement to cut short.
- `listRunningClaimOwners` ignores `hostId`: the store records no worktree, so a running claim on one has no host to
  match. It reads claims on no worktree only.
- `listRunningRequestStalls` reports `no_root_progress` and `waiting` as the SQL does for a request with no worktree.
- Postgres rejects a malformed uuid or bigint argument in a cast. The store compares text and does not reproduce that
  error, except `floor`, which must parse as an integer.
- `readCounterDrift` sums the receipt and topology bytes for the `brain` row as Postgres does; the topology bytes come
  from `topology_terminal_bytes` in `persistence/topology.rs`.

## Answered in TypeScript with no store call

The store has no writer for these relations, so they hold no row on a Rust brain and each answers the empty state the
same read gives on a PGLite brain with none (the precedent is `store-members/connect-gate.ts` and "TypeScript journal
members" in [journal.md](journal.md)). Each is listed in `TODOS.md` under "Rust engine lane 14 follow-ups" for the day
the store gains the writer.

| JS | Answer | Why |
| --- | --- | --- |
| `readLiveConsumerSummary()` | `{ live: "0", oldest_hours: null }` | no consumer heartbeat is recorded |
| `countParkedEffects()`, `listParkedEffects()` | 0, `[]` | no effect is recorded |
| `listGitPushHoldRows()`, `listStalledCatchupRows()`, `listParkedGroupRows()` | `[]` | no effect or worktree is recorded |
| `readStaleEmbeddingCounts()`, `listStaleEmbeddingEffects()` | zeros, `[]` | no embedding effect is recorded |
| `listOrphanBindingRows()`, `listWorktreeIds()`, `listSourceBindingsForMovement()`, `listOwnerBindings()`, `listConsumerOwners()`, `listStuckWorktreeRefreshes()` | `[]` | the store records no worktree, host binding or consumer |
| `listDerivationPurgeSweeps()` | `[]` | no derivation-result sweep of a fact purge is recorded |
| `listUnboundSourcePages()` | `[]` | a page has no `database_only_reason` |
| `listOverwriteCandidates()` | `[]` | page versions carry no link to the request that wrote them |
| `readWriterVersionCutoff()` | the epoch | the store has no migration cutoff, so every request counts as after it |

## Still raw

Reads in `src/core/repair/failed-writes.ts` after the first two (by slug, by digest, the replay states), the prior
refusal read in `src/core/persistence/refusal-breaker.ts` (the admission path), and the per-binding reads in
`src/core/persistence/sync-movement.ts` still go through `executeRaw`; on a Rust brain they refuse with the typed
capability error. They are listed in `TODOS.md`.
