# Keyspace catalog

`gbrain_store::keyspaces` lists every top-level key tag of `keys.rs`: the tag, the family that owns
every byte after it, what its records are and, for the families whose next byte names a record kind
(`A` takes, `R` keyword, `a` telemetry), those kinds. The addon returns it from `brain.keyspaces()`
as `{ format_version, keyspaces: [{ tag, family, records, kinds: [{ kind, name }] }] }`.

It describes what kinds of record this store format keeps, not what one brain holds. It changes
only when `keys.rs` or a family's kind bytes change; the module's tests fail when it drifts from
them (a tag missing or out of byte order, a take kind byte that is not declared).

The TypeScript engine reads it for `listCatalogRelations`, the engine graduation inventory's
relation-set read (`src/core/rust-engine/store-members/graduation-catalog.ts`). The same
inventory's `readCatalogSchemaVersion` reads `brain.info().schema_version`, and
`listCatalogForeignKeys` refuses by name: each family checks its references in code, and the store
keeps no list of them.

That refusal is a stop by design, not a member waiting for a lane. It is `engine_capability_missing`
with capability `raw_sql`, outcome `none` and nothing written, and its detail names the member and
why: `member=listCatalogForeignKeys (the store checks each family's references in code and keeps no
list of them)`. The graduation callers meet it before any work: the copy order (`copyOrder`) stops
earlier, at the relation-set read, and the re-copy closure (`fkClosure`) and the target's foreign-key
check (`verifyForeignKeys`) stop here. None of them answers an empty list, which would read as a store
with no references. `test/engine-parity/graduation-catalog.test.ts` pins the exact stop on the Rust
arm, for the member and for `fkClosure`. It stays a stop until the store records its references as
data.

The tags whose `keys.rs` lines carry no family comment belong to the core store and are listed
under the family `core`.
