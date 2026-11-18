# The brain store: Write trust context

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

PGLite's trust triggers and the fence guard's reads take the writer's trust from six transaction-local settings,
which `src/core/persistence/context.ts` sets with `set_config(name, value, true)` and reads with
`current_setting(name, true)`. The store has no SQL session, so `gbrain_store::write_trust` holds the same six
settings on the open store. It writes no records and has no keys.

| Setting | Read as | Reader |
| --- | --- | --- |
| `gbrain.write_trust_tier` | the writer's declared tier | the fence reads (`FenceContext::writer`), `trust::stamp` |
| `gbrain.write_origin` | the write origin JSON | `trust::stamp` |
| `gbrain.write_trust_promotion` | the owner-confirmed raise ceiling | `trust::stamp` |
| `gbrain.write_trust_backfill` | `on` turns the backfill rule on | `trust::stamp` |
| `gbrain.write_trust_keep` | the tables whose content changes keep the tier | `trust::stamp` |
| `gbrain.write_open_facts` | the fact ids `gbrain repair open-facts` opens | the fence reads (`FenceContext::opened`) |

## Methods

- `apply_write_trust(names, values)` (napi `applyWriteTrust`): `applyTransactionSettings` for these names. Sets
  each named setting to the text at its index, all or nothing.
- `read_write_trust(names)` (napi `readWriteTrust`): `readTransactionSettings` for these names. The text each
  setting was last set to, in `names` order; `null` where it was never set, `''` where it was set empty.
- `clear_write_trust()` (napi `clearWriteTrust`): ends the context, as the end of a transaction ends `SET LOCAL`.
  Every setting reads as never set again.
- `fence_context()`: the `FenceContext` the napi `listFenceFactRows` and `listFenceRetireCandidates` pass. An empty
  or unset tier is an undeclared writer (`unknown`). The opened ids are the pieces of the comma list that are the
  canonical text of an id: `f.id::text = ANY(string_to_array(setting, ','))` compares text, so `007`, ` 7` and `x`
  open nothing.
- `write_trust()` (crate-only): the `WriteTrust` that `trust::stamp` takes. No writer calls it yet (lane 4).

## Lifetime

PGLite's settings end with the transaction. The Rust engine has no store transaction yet (`transactions.rs`), so
the context stays on the open store until `clear_write_trust`. The engine's transaction must clear it at commit and
at rollback; until the engine serves `transaction`, the parity cases set and clear it directly
(`test/engine-parity/rust-arm.ts` `applyRustWriteTrust`). The context is per open store, not per call: two
transactions open at once on one store would share it. When the engine binds a transaction to its own store
handle, the context moves to that handle.

## Rust guesses and gaps (1x parity)

- Stricter than PGLite, on purpose. A value the trust rules would refuse when they read it is refused when it is
  set, with `invalid_argument`, and the context is unchanged:
  - a tier or promotion name that is no tier (PGLite accepts it in `set_config`, raises `22023` in the stamp
    trigger, and ranks it 0 in the fence read);
  - a `write_origin` that is not JSON (PGLite raises at the trigger's `::jsonb` cast);
  - a setting name outside the six (the engine routes no other name here);
  - lists of different lengths.
  TypeScript sets none of these.
- The context carries no principal or write request, so a trust proposal the store files reads
  `proposer_principal_kind`, `proposer_principal_id` and `write_request_id` NULL ([trust.md](trust.md#trust-proposals-trustproposals)).
