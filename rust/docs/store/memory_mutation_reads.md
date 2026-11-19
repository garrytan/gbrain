# The brain store: memory mutation reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`remember` and `forget` (`src/core/persistence/memory-mutations.ts`) read a source, a fact and a page set before they
admit a write; a remote `forget` also reads the target's tier (`guardRemoteForget`, `src/core/trust/supersede-handlers.ts`),
and every `forget` reads the fact it names (`readForgetTarget` in `src/core/persistence/forget-prepare.ts`). PGLite and Postgres run the SQL in `src/core/engine-sql/memory-mutation-reads.ts`. The store answers
from the source, fact and page records the other families write
(`crates/gbrain-store/src/memory_mutation_reads.rs`). It keeps no records of its own and adds no key prefix.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readSourceWriteRow(sourceId)` | `{ incarnation, archived, local_path, kind, role }`, with `kind` and `role` as `config->>key` text, or null for an unknown source | `readSourceWriteRow` |
| `brain.readSourceLocalPath(sourceId)` | the source's `local_path`, or null | `readSourceLocalPath` |
| `brain.readFactEntitySlug(id, sourceId)` | the fact's `entity_slug` when the fact belongs to the source, else null | `readFactEntitySlug` |
| `brain.hasLiveFileBackedPage(sourceId, slugs)` | whether a page of the source among the slugs is live and has a `source_path` | `hasLiveFileBackedPage` |
| `brain.factReadableUnder({ id, sourceId, anyVisibility, minTrust, suppressFlagged, excludePrivate })` | whether the caller reads the fact | `factReadableUnder` |
| `brain.readRemoteForgetTier({ factId, sourceId, remoteFloor })` | the fact's stored `trust_tier` when it belongs to the source and is `world`, else null; `remoteFloor` is null or `{ honorAliases, restricted }` | `readRemoteForgetTier` |
| `brain.readForgetTarget({ id, sourceId, worldOnly, remoteFloor, ownPage })` | `{ id, entity_slug, source_markdown_slug, row_num, expired_at, trust_tier }` for the fact the forget names, or null; `remoteFloor` is null or `{ honorAliases, restricted }`, `ownPage` is null or `{ slug, reader }` | `readForgetTarget` |

## Rules

- `factReadableUnder` checks, in this order: the fact belongs to the source; its visibility is `world` unless
  `anyVisibility` (the brain owner); its provenance page is not deleted or quarantined; the trust floor and flag
  suppression admit it (`TrustPolicy`); and, with `excludePrivate`, the private-provenance policy
  (`facts/privacy.rs`) does not hide it. The store keeps no `needs_rederive` queue, so that part of
  `projectionEligibleSql` hides nothing.
- `readRemoteForgetTier` with `remoteFloor` also drops a fact whose provenance page exists and fails the page policy
  for the empty identity (`hidden_by_provenance_page` in `facts/privacy.rs`): `privateProvenanceFilterFragment`, the
  provenance half of the fact policy, with no entity gate. With `restricted: false` (a brain that holds no
  member-access restrictions) the member-access part is only "names no readers", with no origin test. The store keeps
  no owner-only source, folder rule or pending coverage, so those conjuncts hide nothing.
- `readForgetTarget` reads the fact when it belongs to the source and, with `ownPage`, is `private`, cites the
  member's page as its provenance, and that page is live and names `reader` in its readers; otherwise when it is
  `world` or `worldOnly` is false, and, with `remoteFloor`, passes the same provenance-page check as
  `readRemoteForgetTier`. `expired_at` comes back as an ISO string, which the TypeScript member turns into a `Date`.
  The engines' `lock` (`FOR UPDATE`) changes nothing in the store: its transactions are serial.
- A negative fact id reads as no fact (null or false), as the SQL `WHERE id=$1` does.
- The TypeScript member (`src/core/rust-engine/store-members/memory-mutation-reads.ts`) refuses with
  `engine_capability_missing`:
  - a fact id that is not a safe integer;
  - `factReadableUnder` for a caller whose world rule a member page or a private-facts grant widens
    (`factVisibilitySql('facts', ['world'])` renders more than `facts.visibility IN ('world')`);
  - `excludePrivate` for a caller policy `storePrivacyPolicy` refuses;
  - `readRemoteForgetTier` under `remoteFloor` when `remoteProvenanceFloorSql('facts')` renders other text than with
    no caller record or with a fresh record carrying only the caller's `restricted`, `owner` and schema version (a
    labelled-only caller, folder coverage or a relaxed privacy setting);
  - `readForgetTarget` under `remoteFloor` (without `ownPage`) on the same terms.
- Pinned by `test/engine-parity/memory-mutation-reads.test.ts` on every arm and by
  `crates/gbrain-store/tests/memory_mutation_reads.rs`.
