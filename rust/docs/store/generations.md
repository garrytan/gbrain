# The brain store: derived generations

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The derived generation family keeps the generation ledger of `src/core/generations/publish.ts`: one row per
generation of a derived key (`derived_generations`) and the items each generation records
(`derived_generation_items`), under key tag `h` (`keys::DERIVED_GENERATION`). It ports
`src/core/engine-sql/derived-generations.ts` and the held fence statements of `src/core/engine-sql/fence-holds.ts`.
The key layout is in the module header of `rust/crates/gbrain-store/src/generations.rs`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readLiveGenerationRow(key)` | `{ id, generation, input_pin, input_size, locator, items: [{ item_key, identity_hash }] }` for the key's live row, or `null`. `items` holds the items the generation owns (`published`, `kept`, `adopted`, `revived`) in `item_key` order | `readLiveGenerationRow` |
| `brain.activateGenerationRows(key, liveId, row, items)` | the new row's id. Supersedes the live row `liveId` (when not null), inserts `row` as the key's live generation with `items`, and deletes the key's held row, in one write | `activateGenerationRows` |
| `brain.recordHeldGenerationRow(key, row)` | `null`. The same `holdId` counts one more attempt; another hold replaces the key's held row | `recordHeldGenerationRow` |
| `brain.heldGenerationRowsForInput(key, pin)` | `[{ hold_id, item_set_hash, held_reason }]` for the key's held row when its `input_pin` is `pin`, else `[]` | `heldGenerationRowsForInput` |
| `brain.readHeldGenerationContext(key, holdId)` | `{ held_context }` of the key's held row when its `hold_id` is `holdId`, or `null` | `readHeldGenerationContext` |
| `brain.liveGenerationForOperation(operationId)` | the `generation` of the live row with that `operation_id`, or `null` (a superseded row never answers) | `liveGenerationForOperation` |
| `brain.countGenerationAttempt(key, holdId, code)` | `{ attempts, codes }`. A new `holdId` row starts at one attempt and `[code]`; an existing row adds one and appends `code`, and keeps its own key | `countGenerationAttempt` |
| `brain.clearGenerationAttempts(holdId)` | `null`. Deletes the attempt row `holdId` | `clearGenerationAttempts` |
| `brain.readGenerationValve(key, windowKey)` | `{ retired, owned }`: the retirements of the source and kind's valve window (`null`: no row), and the count of items the source and kind's live generations own | `readGenerationValve` |
| `brain.bumpGenerationValve(key, windowKey, retired)` | `null`. Adds `retired` to the window (a new window starts at `retired`) | `bumpGenerationValve` |
| `brain.listFenceHoldRows(sourceIds, kinds, ownerKey?)` | the held rows of those sources and kinds (one owner when given), `{ source_id, kind, owner_key, held_reason, held_context, created_at }`, oldest first; `created_at` is Postgres `timestamptz` text | `listFenceHoldRows` |
| `brain.clearFenceHoldRows(key)` | `null`. Deletes the key's held row when its reason is `fence_absent` or `no_proof` | `clearFenceHoldRows` |

`key` is `{ sourceId, kind, ownerKey }`. Errors, and nothing is written:

- an unknown source is `source_not_found`;
- a second live row of one key is `constraint_violation` (`derived_generations_one_live`), and a repeated item key is
  `constraint_violation` (`derived_generation_items_pkey`);
- a held reason or item action outside the table's CHECK list is `constraint_violation`;
- U+0000 in any text, JSON text that does not parse, and an id, size or generation out of its integer range are
  `invalid_argument`.

The store also keeps `derived_generation_attempts` (one row per hold id, with an index by key, so an activation deletes
the key's counters as the Postgres statement does) and `derived_generation_valve` (one row per source, kind and
window). An unknown source is `source_not_found` for a new attempt or valve row; an attempt or valve total past the
`int4` range, and a fractional `retired`, are `invalid_argument`.

JSON values (`completeness`, `held_context`, `proposal`, `preimage`) read back in jsonb key order. A source delete
removes the source's rows of all four tables (`cascade.rs`).

Every write goes through `Store::write`, so it runs on `access_flag::FlaggingWriter`; this family writes no page
record, so it never sets the member-access flag itself.
