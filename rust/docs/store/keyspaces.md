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

The tags whose `keys.rs` lines carry no family comment belong to the core store and are listed
under the family `core`.
