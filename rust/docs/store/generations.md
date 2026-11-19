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
| `brain.scrubGenerationPageRows(sourceId, kinds, slug)` | `{ derived_generation_items, derived_generations }`. Deletes the held rows of `kinds` owned by `page:<slug>`, nulls the preimage of item `slug` in the source's generations, nulls every held proposal of an owner ending in `:<slug>` or naming `slug` as an element `key`, and drops the `fence` block of the completeness of rows owned by `page:<slug>`; the counts are the items and rows changed | `scrubGenerationPageRows` (engine-sql/generation-ledger.ts) |
| `brain.scrubGenerationTextRows(sourceId, needles)` | the same counts. Nulls the source's item preimages, held proposals and contexts (a row's both together), and completeness `fence` blocks whose lowered jsonb text contains a needle | `scrubGenerationTextRows` |
| `brain.recordGenerationActivation(key, record)` | `null`. Inserts one `derived_generation_activations` row per member of `record` (`{ activationId, expectedGeneration, inputPin, setHash, members }`, `members` a JSON array of `{ slug, action, identity, before }`) in state `pending`; a row whose `(id, slug)` exists keeps its values (`ON CONFLICT DO NOTHING`) | `recordGenerationActivation` (engine-sql/generation-activations.ts) |
| `brain.markGenerationActivated(activationId, generationId)` | `null`. Sets every row of the activation to `activated` and points it at the generation; a generation that does not exist is `constraint_violation` (`derived_generation_activations_generation_id_fkey`) | `markGenerationActivated` |
| `brain.readGenerationActivationState(activationId, slug, sourceId)` | `{ state, generation_state, pending }` of the member row (`generation_state` and `pending` are `null` without a generation, `pending` the owned item's flag), or `null` | `readGenerationActivationState` |
| `brain.settleGenerationMember(activationId, slug)` | `null`. Clears the `pending` flag of item `slug` in the activation's generation | `settleGenerationMember` |
| `brain.listPendingGenerationMembers(sourceIds, kind)` | `[{ source_id, kind, owner_key, generation_id, activation_id, slug, item_action, identity }]` for the activated members whose live generation still marks the item pending, one kind when `kind` is not `null`, in byte order of source, kind, owner and slug | `listPendingGenerationMembers` |
| `brain.listGenerationOrphanCandidates(sourceIds, kind)` | `[{ source_id, kind, owner_key, activation_id, slug, created_at }]` for the pending members whose page is live, whose activation no unfinished write request names, and whose page no live generation of the same kind owns (a retired item does not count) | `listGenerationOrphanCandidates` |
| `brain.readGenerationItemsByIds(ids)` | `[{ generation_id, item_key, identity_hash, action, preimage }]`, every ledger item of those generations, in id and item key order (Postgres sends no ORDER BY) | `readGenerationItemsByIds` |
| `brain.listUnmatchedGenerationRows(sourceIds, kind, filter)` | `[{ id, source_id, owner_key, activation_id, unmatched }]` for the live rows whose `completeness.unmatched` is an array, in id order | `listUnmatchedGenerationRows` |
| `brain.listRestorableGenerationRows(sourceIds, kind, filter)` | `[{ id, source_id, owner_key, generation, prev_id, prev_generation }]`, each live row with each superseded row whose `superseded_by` names it (in any source or kind, as the SQL join does), in id order | `listRestorableGenerationRows` |
| `brain.listHeldGenerationRows(sourceIds, kind, filter)` | `[{ id, source_id, owner_key, held_reason, hold_id, input_pin, attempts, proposal_bytes, items }]`; `items` is the proposal's length, null without one, and a non-array proposal is `invalid_argument` (as `jsonb_array_length` refuses it) | `listHeldGenerationRows` |
| `brain.readHeldGenerationProposal(id)` | `{ proposal, hold_id }` of the row while it is held, or `null` | `readHeldGenerationProposal` |
| `brain.listRecordedFenceItemKeys(key, itemKeys)` | `[{ item_key }]`, each key of `itemKeys` that an item of a generation of `key` not held records with an action other than `retired`, once each, in key order (Postgres sends `SELECT DISTINCT` with no ORDER BY) | `listRecordedFenceItemKeys` |
| `brain.hasBodylessPageVersion(sourceId, slug)` | whether a stored version of the page has a null `compiled_truth`; `false` for a missing page | `hasBodylessPageVersion` |
| `brain.listFenceVersionBodies(sourceId, slug, before, limit)` | `[{ id, compiled_truth, timeline }]`, the page's stored versions with a body whose body or timeline holds `gbrain:facts:`, below id `before` when not null, newest first, at most `limit` (a negative limit is `invalid_argument`) | `listFenceVersionBodies` |
| `brain.moveKeptFactRows(sourceId, slug, ids, claimed)` | `null`. The fact rows of `ids` in the source whose row number is in `claimed` take `top + 1`, `top + 2`, ... in (row number, id) order, `top` the largest row number of page `slug` and of `claimed` (0 when both are empty) | `moveKeptFactRows` |
| `brain.readGenerationFenceBlocks(ids)` | `[{ id, fence }]` for each generation of `ids` that exists, `fence` the `completeness.fence` value or `null`, in id order (Postgres sends no ORDER BY) | `readGenerationFenceBlocks` |
| `brain.listOwnedGenerationItems(ids)` | `[{ generation_id, item_key }]` for the items of those generations whose action is not `retired`, in id and item key order (Postgres sends no ORDER BY) | `listOwnedGenerationItems` |
| `brain.readLiveGenerationId(key)` | `{ id }` of the key's live row, or `null` | `readLiveGenerationId` |
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

The scrub reads the jsonb text Postgres prints (`cli_reads::pg_text::jsonb_text`) and lowers it as Postgres `lower()` does in a UTF-8 database with the C.UTF-8 ctype. One difference stays: a stored JSON `null` and an absent value are the same in the store, and numbers print in their shortest form (`1.0` reads `1`).

The activation rows live under `h 0x08 id` with a reverse index `h 0x09 generation_id id`, so a deleted generation
row sets its activations' `generation_id` to null (`ON DELETE SET NULL`). The orphan list reads the write journal and
the page records. One difference stays: an activation id that is not a UUID matches no write request in the store,
where Postgres's `a.id::uuid` cast may refuse the statement; managed.ts always writes UUIDs.

The repair lists take the filter `{ runId?, since?, ownerKey?, id? }` (`generations/repair.rs`): each present field
narrows the rows as its SQL fragment does, a row with a null `run_id` never matches a run, and `since` must be an ISO
instant (other text is `invalid_argument`, where Postgres's `::timestamptz` cast accepts more forms; repair.ts always
passes a concrete ISO instant, `GenerationsSelection.since`). `listSourceIncarnations` is not a store
method: the TypeScript member reads `readSourceIncarnation` once per distinct id and sorts by id in code-unit order.

The fence evidence and restore reads (`generations/fence_evidence.rs`, `generations/fence_restore.rs`) and the kept row
move (`facts/kept_rows.rs`) add no keys: they read the ledger rows and items, the page and version records, and the
fact records. Ids read back as integers. Where the statement has no ORDER BY, the store answers in a fixed order (key
order, id order); fence-evidence.ts and fence-restore.ts read the rows into sets and maps, so no caller depends on the
order. As in the statement, the move does not name the page for the moving rows: a claimed row of another page of the
source moves too (fence-evidence.ts passes the page's own rows).

JSON values (`completeness`, `held_context`, `proposal`, `preimage`) read back in jsonb key order. A source delete
removes the source's rows of all five tables (`cascade.rs`).

Every write goes through `Store::write`, so it runs on `access_flag::FlaggingWriter`; this family writes no page
record, so it never sets the member-access flag itself.
