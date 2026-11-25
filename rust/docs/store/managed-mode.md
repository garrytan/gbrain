# Managed mode on the Rust store

A managed brain keeps its pages as files in a Git checkout; every write goes to the database and to
that checkout. The Rust engine holds the `managed_persistence` capability back
(`src/core/rust-engine/store-capabilities.ts` `HELD_FOR_CALLERS`), so a user's Rust brain refuses
managed mode by name. The members below serve managed mode behind that hold; a test lifts the hold
on one engine instance (`test/engine-parity/rust-managed.ts`) and
`test/engine-parity/managed-on-rust.test.ts` compares them with PGLite and Postgres.

Each family is one BrainEngine store member whose SQL lives unchanged in `src/core/engine-sql/`, and
on this engine one tagged read call and one tagged write call (`{ kind, ...args }`).

| BrainEngine member | SQL | Rust | Calls |
| --- | --- | --- | --- |
| `gitDurabilityStore()` | `engine-sql/git-durability.ts` | `persistence/git_durability.rs` | `gitDurabilityRows`, `gitDurabilityWrite` |
| `gitEffectStore()` | `engine-sql/git-effects.ts` | `persistence/git_effects.rs` | `gitEffectRows`, `gitEffectWrite` |
| `topologyStore()` | `engine-sql/topology-store.ts` | `persistence/topology_store.rs` | `topologyRows`, `topologyWrite` |
| `manualLinkStore()` | `engine-sql/manual-links.ts` | `link_queries/manual_links.rs` | `manualLinkRows`, `manualLinkWrite` |
| `claimCoalescedGitEffects(input)` | `engine-sql/persistence-effect-worker.ts` | `persistence/effect_worker.rs` | `claimCoalescedGitEffects` |

## Locks become stated guarantees

The SQL takes row locks (`FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`) and sets transaction bounds
(`lock_timeout`, `statement_timeout`, `synchronous_commit`, `gbrain.topology_change`). The Rust store
takes none of them and adds no lock of its own (no file lock, no process-wide mutex, no busy error):

- An explicit transaction is Serialized: it holds the store's writer, so no other commit interleaves
  with what it read. The callers' compare-and-set checks on owner epoch, topology generation,
  incarnation and state stay as they are.
- Under optimistic transactions (`GBRAIN_RUST_MULTIUSER=1`, lane L1) every record these members read
  is in the transaction's read set, so a racing change aborts the commit with `write_conflict`
  instead of being missed.
- The coalesced Git claim stamps each effect it read in the same write, so two claimers never both
  claim one effect.
- The checkout-level native locks of `withTopologyLocks` (`GBRAIN_HOME/locks`) are the same on every
  engine: they guard the checkout's files on this host, not the store.

## What each family answers

- Git durability: the newest skipped Git effect per file of a worktree's current incarnation (the
  catch-up plan), its re-queue under the plan's predicates (`data.durability_catch_up` + 1), and the
  host binding's `git_durability` (null when no binding matches; another value is the CHECK's
  `constraint_violation`).
- Git effects: whether a worktree has a queued or running request, the `bool_and` over its requests
  that hold a recovery record (null when none does), whether any request holds one, the yield of a
  claimed group to queued publications (`publication_pending`, due after the delay), and the plain
  outcome of a group with no durability (`targets_parked` when targets parked). Every write names
  each effect by id and claim token.
- Topology: the worktree rows in id order, the active refresh other than the caller's, member
  sources, host bindings, the canonical stamp (md5 of `page id:knowledge revision:incarnation` in
  page id order, soft-deleted pages included), unsettled requests in sequence order, the blocking
  effect, the receipt counters (a missing counter row changes nothing; one below zero is
  `constraint_violation`), retire admissions, the lifecycle's source writes (archive keeps an
  earlier archive time and sets a 72-hour window), the incarnation delete with its scrub
  (`sources/archive.rs` `delete_source_incarnation_in`), page batches in page id order, and the
  moved-checkout reads.
- Manual links: the page's fenced edges by target slug, type and source in byte order, its manual
  dated statements, the relationship's database-only and fenced edges (a null link source is
  database-only only when no producer is managed), the fence projection's link and transition
  writes (an existing fenced edge keeps its id; a transition with the same identity is not
  inserted again). The link-transition identity always carries the link source here.
