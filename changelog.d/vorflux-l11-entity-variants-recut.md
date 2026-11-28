**A Rust brain answers an entity name that has no page with the same name variants and suggestions as PGLite and Postgres.**

### Changed
- The entity tool and rank_entities read a name's variants (reordered names, titles such as Dr or Mayor) through typed engine calls: `listVisibleNameVariantCandidates`, `listNameVariantCardCandidates` and `readVisibleVariantPages`. On a Rust brain those reads used to refuse, so an entity miss came back with no suggestions and rank_entities listed no possible duplicates.
- A remote caller is never shown a private page as a variant, a suggestion or a duplicate, on any engine.
- Tests: `test/engine-parity/entity-variants.test.ts` checks the entity miss, a resolved variant, a retired variant and rank_entities through the MCP dispatcher on every engine arm.
