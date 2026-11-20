# The brain store: Source contextual-retrieval mode

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A source's own contextual-retrieval mode (`sources.contextual_retrieval_mode`), which `gbrain sources set-cr-mode` writes.
A source with no mode falls through to the global mode. The TypeScript statement is in
`src/core/engine-sql/source-cr-mode.ts`; the store module is `rust/crates/gbrain-store/src/source_cr_mode.rs`; the addon
methods are in `rust/crates/gbrain-napi/src/families/source_cr_mode.rs`.

| Key | Value | Mirrors |
| --- | --- | --- |
| `M source_cr_mode/<source id>` | `{ mode, incarnation }` (JSON) | `sources.contextual_retrieval_mode`; no record is `NULL` |

The record sits beside the source record (`S <source id>`, owned by `sources.rs`), not in it. It names the incarnation of
the source it was written for, and a mode counts only while that incarnation is the live one: a source deleted and
created again under the same id reads as having no mode, as a new SQL row does. The store keeps any mode string, as the
SQL column does; the command checks the value against `CR_MODES` first.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.setSourceContextualMode(id, mode)` | `true` when the source exists (archived or not): the mode is stored, or the record is removed for `null`. `false` when no source has the id, and nothing is written | `setSourceContextualMode` |
| `brain.readSourceContextualMode(id)` | the source's mode, or `null` when none is set or no source has the id | the `contextual_retrieval_mode` column of `getSource` |

Readers:

- `getSource` (TypeScript member `store-members/sources.ts`) reads the source row, then this mode, so the row's
  `contextual_retrieval_mode` is the stored mode (archived sources included), as the SQL column is.
- `readSynopsisTierSources` and `listSynopsisSourceIds` list the sources that are not archived and whose mode is
  `per_chunk_synopsis`, by id in byte order ([synopsis-tier.md](synopsis-tier.md)).
