# The brain store: Transactions

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The native store and addon provide explicit transaction handles, savepoints, commit, rollback and page-key
holds (`crates/gbrain-napi/src/families/transactions.rs`). The TypeScript side is not landed: the current
`src/core/rust-engine/store-members/transactions.ts` exports no BrainEngine member, so `engine.transaction`,
`engine.transactionDirect`, `engine.lockPageKeys`, `readTransactionSettings` and `applyTransactionSettings` refuse
with `engine_capability_missing` on this landing. The JavaScript callback, gating, re-entry and disconnect behaviour
below is the intended adapter contract, not BrainEngine behaviour available now.

`engine.transaction(fn, opts?)`, `engine.transactionDirect(fn)` and `engine.lockPageKeys(keys)` are meant to run on
the Rust engine with PGLite's observable behaviour. `fn` gets a transaction engine (a clone of the
engine); every member called on it reads the transaction's own writes, and the whole transaction
becomes visible to the brain in one commit, or not at all.

## The contract

1. **Commit or roll back.** When `fn` resolves, the transaction commits and `transaction` resolves
   with `fn`'s value. When `fn` throws, the transaction rolls back and the same error is rethrown.
   A commit that fails rolls back and rejects with the mapped store error.
2. **A nested transaction is a savepoint.** `tx.transaction(inner)` opens a savepoint. A throw in
   `inner` rolls back only the savepoint and rethrows; success releases it into the parent. An
   outer rollback also drops released savepoints. Sibling savepoints on one handle run one at a
   time.
3. **One writer at a time; readers never wait.** The engine gates writes in JavaScript. While a
   transaction is open, a write on the engine itself (outside `fn`) waits until the transaction
   ends. A read on the engine runs at once and sees the last committed state, never the open
   transaction's writes. The store also has a single writer, so the gate only keeps the wait in
   JavaScript instead of a blocked worker thread.
4. **Re-entry is refused.** Calling a member on the engine itself from inside its own `fn` would
   wait forever for the writer `fn` holds. It throws `internal_error` with reason
   `transaction_reentry` (`detail: "member=<name>"`) instead. Use the `tx` handle.
5. **`lockPageKeys(keys)`** needs a transaction, as on PGLite (`lockPageKeys requires
   engine.transaction()` outside one). Inside one it validates the keys as PGLite does (exact
   `sourceId`, a valid slug), drops duplicates and keys already held, sorts them, and checks each
   source: a missing source throws `PageSourceMissingError` (`Page source does not exist: <id>`);
   a page-key hint whose source incarnation changed throws `Page source was recreated: <id>`. The
   keys stay held until the transaction or savepoint that took them ends.
6. **`transactionDirect(fn)`** is `transaction(fn)`, as on PGLite.
7. **Ids are never reused.** An allocator (`next_*` counter) only moves forward. A rolled-back
   statement, savepoint or transaction keeps the highest value it reached, and a rollback writes
   that value back in its own commit, so an id taken in a rolled-back transaction is not handed out
   again, also after the brain is reopened. After a crash this holds in multi-user mode only, which
   reserves id ranges on disk (see the optimistic section below).
8. **Journaled writes roll back with the transaction.** A write request and its receipt are
   ordinary records in the same transaction: after a rollback the request was never admitted.
9. **Disconnect.** `disconnect()` waits up to 5 seconds for an open transaction to end. After that
   it rolls the transaction back and closes it. The pending `transaction` call rejects with
   `engine_closed`, and every later call on the `tx` handle gets `engine_closed`.
10. **One time per transaction.** Every row a transaction writes reads the time the transaction
    began, as PGLite's `now()` does, so two facts inserted in one transaction share `created_at`.
    The time moves on again for the next transaction.
11. **Error codes** are the existing ones: `invalid_state`, `store_closed` (mapped to
    `engine_closed`), `source_not_found`, `source_changed`, `internal_error`, `cancelled`.
12. **Transaction-local settings.** `applyTransactionSettings(names, values)` and
    `readTransactionSettings(names)` are `set_config(name, value, true)` and
    `current_setting(name, true)`:
    - Inside a transaction, a setting reads back what was last applied in it. The six write trust
      settings and the three attribution settings (`gbrain.write_request`,
      `gbrain.write_principal_kind`, `gbrain.write_principal_id`) go to the write context on the
      transaction's handle ([`write_trust.md`](write_trust.md)). `gbrain.write_sources`,
      `gbrain.git_protocol`, `gbrain.persistence_protocol` and `gbrain.writer_quiesced` stay on
      the transaction in TypeScript (`RustTransactionScope.settings`).
      `gbrain.git_protocol` and `gbrain.persistence_protocol` stay on the transaction in
      TypeScript (`RustTransactionScope.settings`).
    - Any other custom name Postgres accepts, `gbrain` and one or more simple identifiers
      (`^gbrain(\.[a-z_][a-z0-9_]*)+$`), stays on the transaction too, unless schema SQL reads it.
      The names the schema's triggers and functions read and no store writer reads yet
      (`gbrain.materializing_revision`, `writer_quiesced`, `topology_change`, `refresh_barrier`,
      `trust_generation_bumped`, `guest_note`, `graduation_run`) refuse, so a caller never sets
      one that changes Postgres and nothing here.
    - `plan_cache_mode` stays on the transaction too, for the belief batch probe
      (`readLedgerSource` with `batch`). It reads `auto` when unset, inside a transaction or not,
      and an apply takes `auto`, `force_generic_plan` or `force_custom_plan` (any case, kept in
      lower case) or throws `invalid value for parameter "plan_cache_mode": "<value>"`. The store
      has no planner, so the setting changes nothing else.
    - They end with the transaction. A savepoint rollback restores them; a release keeps them.
    - Outside a transaction an apply keeps nothing, as a lone `set_config(..., true)` on PGLite.
    - A name never set reads `null`. A name set before on the engine reads `''`, as Postgres
      keeps a placeholder for it on the connection.
    - A name outside `^[a-z_][a-z0-9_.]*$` throws `Invalid transaction setting name: <name>`, as
      on PGLite. Any other name (`gbrain.`, `gbrain..x`, `gbrain.1x`, a name with no dot, a
      schema-read name) refuses with `engine_capability_missing`, reason `transactions`,
      `detail: "member=<m> capability=transactions setting=<name> outcome=none written=nothing"`.
    - Two transactions never see each other's settings. The store admits one write transaction at
      a time: a second `begin_transaction` waits for the writer, and each transaction's handle has
      its own context, which starts empty.
    - `readCurrentWriteTrust()` (`store-members/write-context.ts`) is `readTransactionSettings`
      for `gbrain.write_trust_tier` and `gbrain.write_origin`, returned as `{ tier, origin }`.
      PGLite and Postgres send the text `persistence/context.ts` `currentWriteTrust` always sent
      (`CURRENT_WRITE_TRUST_SQL` in `src/core/engine-sql/transaction-settings.ts`).
    - `setWriteContext(input)` (same file) is the coordinated write's context in steps: it reads the
      seven `WRITE_CONTEXT_SETTINGS` ('' where unset) and the persistence identity, and sets nothing
      when there is none. Otherwise it applies the source scope and `gbrain.git_protocol = '1'`, keeps
      an enclosing actor (one with a principal kind), and, for a declared tier, keeps an enclosing tier
      of lower nonzero rank and takes the declared origin or the enclosing one. PGLite and Postgres
      send `SET_WRITE_CONTEXT_SQL`, the one statement `withCoordinatedWrite` always sent.

An `AbortSignal` in `opts` is honoured before the transaction starts and while it waits at the
gate (`cancelled`); once `fn` runs the signal is ignored, as on PGLite.

## Read-only transactions

A write inside a read-only transaction rejects `read_only_transaction` ("cannot execute a write in a
read-only transaction"), and the statement leaves nothing. The TypeScript engine maps it to
Postgres's refusal: code `25006` (`read_only_sql_transaction`), message `cannot execute <member> in a
read-only transaction`. A transaction becomes read-only two ways:

- `opts.readOnly` at `transaction(fn, opts)`, Postgres's `BEGIN READ ONLY`. PGLite ignores
  `opts.readOnly`; this one is a deliberate divergence from it. Reads inside see a stable snapshot,
  and the commit writes nothing.
- `beginSnapshotRead({ readOnly: true })` inside the transaction, Postgres's `SET TRANSACTION READ
  ONLY`. Writes made before it stay and commit; every write after it refuses. Postgres and PGLite
  refuse the same writes (`test/engine-parity/transaction-settings.test.ts`).

## How it works

| JS (store binding) | Resolves | Mirrors |
| --- | --- | --- |
| `txBrain.beginTransaction(brain, readOnly?)` | `null`; binds `txBrain` to a new transaction on `brain`'s store. `store_closed` when `brain` is closed; `invalid_state` when `txBrain` is already open | `BEGIN` |
| `txBrain.savepoint()` | the new savepoint depth (1, 2, ...) | `SAVEPOINT` |
| `txBrain.releaseSavepoint(depth)` / `rollbackSavepoint(depth)` | `null`; only the innermost savepoint can end, any other depth is `invalid_state` | `RELEASE` / `ROLLBACK TO` |
| `txBrain.setTransactionReadOnly()` | `null`; every later write rejects `read_only_transaction`. `store_closed` once the transaction ended | `SET TRANSACTION READ ONLY` |
| `txBrain.commitTransaction()` | the new commit version; releases the remaining savepoints | `COMMIT` |
| `txBrain.rollbackTransaction()` | `null`; a no-op once the transaction ended | `ROLLBACK` |
| `txBrain.holdPageKeys(keys, hinted)` | every held `[sourceId, slug]`, sorted | `pg_advisory_xact_lock` per key |

Every family method on a bound store runs inside the transaction. A transaction holds the store's
write transaction from begin to end. On top of it the store keeps layers of pending writes: one per
savepoint and one for the statement (a single member call) that is running. A read looks in the
statement layer, then the savepoints from the innermost out, then the base write transaction; a
scan merges the layers with the base in key order, in both directions, and a pending delete hides a
stored record. A statement that fails drops only its own layer, so the caller can catch the error
and carry on, as with a Postgres statement inside a transaction. A statement that succeeds merges
into the innermost savepoint, or into the base when there is none.

Page-key locks are kept in memory, per layer. The store has a single writer, so no lock record is
written; the `w` (lock queue) key tag stays reserved. A scan callback must not call the store
again: the layers are locked while the scan runs.

## Optimistic transactions (multi-user mode)

With multi-user mode on (`GBRAIN_RUST_MULTIUSER=1` or the brain's `engine.rust.multiuser` config row), the engine opens
every explicit transaction optimistically. `TxnMode::Optimistic` on any other brain (the switch off, or the
single-writer store) is refused with `invalid_state`; it never runs serialized in its place. The I-1 handle
`Store::begin_with` returns a `Transaction`: `Transaction::store()` reads and writes through it, `Transaction::commit`
(returning the frozen `CommitPosition`) and `Transaction::rollback` consume it and are the only ways to end it besides a
drop, and its bound store's `commit_transaction` / `rollback_transaction` refuse with `invalid_state`. The binding uses
`begin_bound`, whose bound store ends itself as before (`Store::begin_with` / `begin_bound` with `TxnMode::Optimistic`; the binding's
`beginTransaction(brain, readOnly, { mode: 'optimistic', deadlineAtMs?, retryKeys?, age? })`). Off, nothing here runs.

- The base is an ordinary write of the concurrent store: it reads from a snapshot, records every key and range it read,
  and its commit is validated in the ordered pipeline. Other writers do not wait for it. A refused commit
  (`write_conflict`) keeps nothing; the engine runs the callback again (at most 8 more times, then `revision_conflict`
  with reason `transaction_contention`). A rerun first queues for the keys earlier runs lost on (`retryKeys`), as a
  retried single write does.
- Layers keep `add_i64` and `raise_counter` as typed operations and `counter_below` admissions as checks of their own;
  they reach the base only when the layer merges into it, so counters never conflict and a dropped layer leaves nothing.
- The first `write_conflict` a transaction sees dooms it: `transactionConflicted()` is true and its commit refuses.
- A transaction that ends without committing writes nothing back and raises the id sequences it advanced in a write of
  its own, so no id is handed out twice, also after a reopen.
- Each id sequence also reserves its ids on disk before it hands them out (the record file's `id_reservations`
  table, outside the commit sequence, 65536 ids ahead at a time), and the first allocation after an open starts at or
  above the reservation. So an id is not handed out twice after a crash, a kill or a forward write that never reached
  the disk either. A clean close gives back the unused part of each range, so a reopen numbers on with no gap; a crash
  skips at most 65536 ids per sequence: after a crash or a kill, the next id of each sequence can jump by up to
  65536 (up to 1024 before), and any output that shows a raw id shows that jump. Ids are 64-bit, so they cannot run
  out. Not covered: a promoted follower, whose copy carries no reservation (see `occ_kv.rs`, "Id sequences").
- `holdPageKeys` also takes the keys in the brain's single-flight table until the transaction ends: sorted; a
  transaction that holds no key, or is older than the holder and every waiter ahead of it, waits (bounded by the
  deadline, then `timeout` reason `key_wait`); a younger one that already holds a key is refused and runs again keeping
  its age (`transactionAge()`). Waiters for one key take it first come, first served: a newcomer never takes a key
  ahead of a transaction already waiting for it. The same order holds for a rerun queued on its retry keys.
  A waiter that has read nothing reads on from after the holder's commit.
- `deadlineAtMs` is checked at each statement and when the commit runs; past it the transaction ends `timeout` reason
  `transaction_deadline`. Once the commit is handed to the pipeline, its answer is the result.

On the JavaScript side the engine runs the transaction on its own one-thread pool, so reads on the
engine keep their own threads while the transaction is open.
