# The brain store: derivation edges

Part of the facts family ([facts.md](facts.md)); the rules in [rust/README.md](../../README.md) ("The brain store")
apply.

The store keeps `derivation_inputs` (`src/core/facts/derivation-inputs.ts`): for each derived row, every input row a
deriver placed in the model's context. Keys (family `3`, `derivation_inputs.rs`): `3 0x01 derived_table \0 derived_id
\0 input_table \0 input_id` holds the edge (its source and creation time), and `3 0x02 input_table \0 input_id \0
derived_table \0 derived_id` is the reverse index (`idx_derivation_inputs_input`). A source delete removes the edges
recorded under it.

| Member | Returns |
| --- | --- |
| `brain.recordDerivationEdges({ derived, sourceId, edges })` | nothing. Records each edge not recorded yet (`ON CONFLICT DO NOTHING`) in one write. A table name that is not `^[a-z_][a-z0-9_]{0,62}$`, or a NUL, refuses; a `sourceId` the store does not hold refuses as the foreign key does and records nothing |
| `brain.listDerivedRows({ frontier, limit })` | one hop of the walk: the rows an edge derives from a frontier row, distinct, by `(derived_table, derived_id)` byte order, at most `limit` |
| `brain.countLegacyDerivedPages(sourceId)` | the live atom pages and `dream_generated` pages of the source that no edge names as derived |

The edges feed three reads besides the walk: `listFactsFromQuotedPages` counts a fact whose recorded input page has a
quoted type (`facts/quote.rs`); the owner-only rule (`owner_only.rs`) hides a page, fact, take or timeline row whose
inputs reach, transitively, a marked row or a row held in an owner-only source (`gbrain_owner_only_lineage_strict`);
and a page delete marks every row derived from the page, its takes and its timeline rows (`owner_only_marks.rs`,
`gbrain_owner_only_mark_derived`). A timeline input is found by scanning the timeline, whose keys start with the page.
