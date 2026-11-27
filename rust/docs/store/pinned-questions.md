# The brain store: pinned questions

Part of the Minion jobs family ([jobs.md](jobs.md)); the rules in [rust/README.md](../../README.md) ("The brain store")
apply.

The store keeps a pin as its whole row: the 30 columns of `pinned_questions` that the TypeScript row reads (`updated_at`
is not kept: no member reads it). The SQL for the PGLite and PostgreSQL engines is in
`src/core/engine-sql/pinned-questions.ts` (one constant listing per filter combination, the text the composed listing
sent); the store serves the same members (`jobs/pinned_questions.rs`, keys `m 0x2F` and `m 0x30`).

| Member | Returns |
| --- | --- |
| `brain.insertPinnedQuestion(row)` | the new pin's row, or null when `(source_id, slug)` already has a pin (`ON CONFLICT DO NOTHING`). `row` is `{ sourceId, slug, question, scopeSlugPrefix, scopeEntity, state, inactiveReason, publishMode, createdBy }`; a null `sourceId`, `slug`, `question`, `state`, `publishMode` or `createdBy` refuses with `constraint_violation`. The other columns take the table's defaults (`origin` `pin`, `revision` 1, `answer_revision` 0, `refresh_attempts` 0, `spend_usd` 0, `created_at` now) |
| `brain.readPinnedQuestion(sourceId, slug)` | the pin's row, or null (the unlocked read of `getPin`; the row-locked read stays raw SQL) |
| `brain.listPinnedQuestions(filter)` | the pins by source id in byte order (`ORDER BY source_id COLLATE "C", created_at, id`). `filter.sourceIds` and `filter.states` keep the pins whose value is in the list; with no `states`, the archived pins are left out unless `filter.includeArchived` |

Not served: the pin's state change, its refresh lease, the answer publish and the evidence rows (`src/core/questions/store.ts`
`updatePinState`, `acquireLease`, `releaseLease`, `addSpend`; `refresh.ts`): they are `executeRaw` writes, which a Rust
brain refuses. A pin written on a Rust brain is listed there; its refresh cycle does not run there yet.

A purge probe of `pinned_questions` (src/core/deletion-inventory.ts) searches the stored pins' text columns
(`jobs::purge_probe_pin_rows`).
