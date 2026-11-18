# The brain store: Transactions

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`engine.transaction(fn, opts?)`, `engine.transactionDirect(fn)` and `engine.lockPageKeys(keys)` run on
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
   again, also after the brain is reopened.
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
      settings go to the write trust context on the transaction's handle
      ([`write_trust.md`](write_trust.md)). `gbrain.write_sources`, `gbrain.write_request`,
      `gbrain.write_principal_kind`, `gbrain.write_principal_id` and `gbrain.git_protocol` stay
      on the transaction in TypeScript (`RustTransactionScope.settings`).
    - They end with the transaction. A savepoint rollback restores them; a release keeps them.
    - Outside a transaction an apply keeps nothing, as a lone `set_config(..., true)` on PGLite.
    - A name never set reads `null`. A name set before on the engine reads `''`, as Postgres
      keeps a placeholder for it on the connection.
    - A name outside `^[a-z_][a-z0-9_.]*$` throws `Invalid transaction setting name: <name>`, as
      on PGLite. Any other name refuses with `engine_capability_missing`, reason `transactions`,
      `detail: "member=<m> capability=transactions setting=<name> outcome=none written=nothing"`.
    - Two transactions never see each other's settings. The store admits one write transaction at
      a time: a second `begin_transaction` waits for the writer, and each transaction's handle has
      its own context, which starts empty.
    - `readCurrentWriteTrust()` (`store-members/write-context.ts`) is `readTransactionSettings`
      for `gbrain.write_trust_tier` and `gbrain.write_origin`, returned as `{ tier, origin }`.
      PGLite and Postgres send the text `persistence/context.ts` `currentWriteTrust` always sent
      (`CURRENT_WRITE_TRUST_SQL` in `src/core/engine-sql/transaction-settings.ts`).

An `AbortSignal` in `opts` is honoured before the transaction starts and while it waits at the
gate (`cancelled`); once `fn` runs the signal is ignored, as on PGLite.

## Deliberate divergence: `readOnly`

PGLite ignores `opts.readOnly`. The Rust engine refuses a write inside a `readOnly` transaction with
`invalid_state` ("a read-only transaction refuses writes"). Reads inside it see a stable snapshot.

## How it works

| JS (store binding) | Resolves | Mirrors |
| --- | --- | --- |
| `txBrain.beginTransaction(brain, readOnly?)` | `null`; binds `txBrain` to a new transaction on `brain`'s store. `store_closed` when `brain` is closed; `invalid_state` when `txBrain` is already open | `BEGIN` |
| `txBrain.savepoint()` | the new savepoint depth (1, 2, ...) | `SAVEPOINT` |
| `txBrain.releaseSavepoint(depth)` / `rollbackSavepoint(depth)` | `null`; only the innermost savepoint can end, any other depth is `invalid_state` | `RELEASE` / `ROLLBACK TO` |
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

On the JavaScript side the engine runs the transaction on its own one-thread pool, so reads on the
engine keep their own threads while the transaction is open.
