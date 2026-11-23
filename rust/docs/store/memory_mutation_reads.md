# The brain store: memory mutation reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`remember` and `forget` (`src/core/persistence/memory-mutations.ts`) read a source, a fact and a page set before they
admit a write; a remote `forget` also reads the target's tier (`guardRemoteForget`, `src/core/trust/supersede-handlers.ts`),
and every `forget` reads the fact it names (`readForgetTarget` in `src/core/persistence/forget-prepare.ts`) and what its
withdrawal reaches (`isFactEntityUnbacked`, `readLinkedFactCopies`, `hasHiddenFactCopy` and `ownerReachesFact` there);
the withdrawal plan reads the claim it changes (`readFactWithdrawalClaim`, `planFactWithdrawal` in `src/core/facts/withdrawal.ts`). PGLite and Postgres run the SQL in `src/core/engine-sql/memory-mutation-reads.ts`. The store answers
from the source, fact and page records the other families write
(`crates/gbrain-store/src/memory_mutation_reads.rs`). It keeps no records of its own and adds no key prefix.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readSourceWriteRow(sourceId)` | `{ incarnation, archived, local_path, kind, role }`, with `kind` and `role` as `config->>key` text, or null for an unknown source | `readSourceWriteRow` |
| `brain.readSourceLocalPath(sourceId)` | the source's `local_path`, or null | `readSourceLocalPath` |
| `brain.readFactEntitySlug(id, sourceId)` | the fact's `entity_slug` when the fact belongs to the source, else null | `readFactEntitySlug` |
| `brain.hasLiveFileBackedPage(sourceId, slugs)` | whether a page of the source among the slugs is live and has a `source_path` | `hasLiveFileBackedPage` |
| `brain.factReadableUnder({ id, sourceId, anyVisibility, minTrust, suppressFlagged, excludePrivate })` | whether the caller reads the fact | `factReadableUnder` |
| `brain.readRemoteForgetTier({ factId, sourceId, remoteFloor })` | the fact's stored `trust_tier` when it belongs to the source and is `world`, else null; `remoteFloor` is null or `{ honorAliases, restricted, ownerOnly }` | `readRemoteForgetTier` |
| `brain.readForgetTarget({ id, sourceId, worldOnly, remoteFloor, ownPage })` | `{ id, entity_slug, source_markdown_slug, row_num, expired_at, trust_tier }` for the fact the forget names, or null; `remoteFloor` is null or `{ honorAliases, restricted, ownerOnly }`, `ownPage` is null or `{ slug, reader }` | `readForgetTarget` |
| `brain.isFactEntityUnbacked(id, sourceId)` | whether the fact belongs to the source and names an entity with no `/` and no live page of that slug | `isFactEntityUnbacked` |
| `brain.readLinkedFactCopies({ id, sourceId, worldOnly, remoteFloor })` | `[{ id, entity_slug }]`, the copies of the fact's claim on other entities, by id, at most five; `remoteFloor` is null or `{ honorAliases, restricted, ownerOnly }` | `readLinkedFactCopies` |
| `brain.hasHiddenFactCopy({ id, sourceId, remoteFloor })` | whether a copy of the claim the withdrawal reaches fails the floor; `remoteFloor` is `{ honorAliases, restricted, ownerOnly }` | `hasHiddenFactCopy` |
| `brain.ownerReachesFact({ id, sourceId })` | whether an owner with no member identity reaches the fact | `ownerReachesFact` |
| `brain.readFactWithdrawalClaim({ id, sourceId, worldOnly, memberPage, remoteFloor })` | `{ visibility, fact, fact_hash, subject, expired }` for the claim a withdrawal changes, or null; `remoteFloor` is null or `{ honorAliases, restricted, ownerOnly }` | `readFactWithdrawalClaim` |

## Rules

- `factReadableUnder` checks, in this order: the fact belongs to the source; its visibility is `world` unless
  `anyVisibility` (the brain owner); its provenance page is not deleted or quarantined; the trust floor and flag
  suppression admit it (`TrustPolicy`); and, with `excludePrivate`, the private-provenance policy
  (`facts/privacy.rs`) does not hide it. The store keeps no `needs_rederive` queue, so that part of
  `projectionEligibleSql` hides nothing.
- `readRemoteForgetTier` with `remoteFloor` also drops a fact whose provenance page exists and fails the page policy
  for the empty identity (`hidden_by_provenance_page` in `facts/privacy.rs`): `privateProvenanceFilterFragment`, the
  provenance half of the fact policy, with no entity gate. With `restricted: false` (a brain that holds no
  member-access restrictions) the member-access part is `page_readers IS NULL AND folder_rule_ids IS NULL`: the page
  names no readers and no folder rule stamps it (whether or not the rule covers derived pages), with no origin test;
  a stale flag over a brain that holds a rule still hides the stamped page. The floor also
  drops an owner-only fact and judges the provenance page by the page owner-only test (`owner_only.rs`), both in the
  form `ownerOnly` names: `closed` (no schema version: any owner-only source hides every fact), `fn` (schema 320: only
  a fact or page of an owner-only source) or `off` (the owner, which has no owner-only test). For `restricted: true` the
  folder rules and pending prefixes come from `access_rules.rs` (a stamped rule that covers derived pages, or a
  pending prefix, hides the provenance page).
- `readForgetTarget` reads the fact when it belongs to the source and, with `ownPage`, is `private`, cites the
  member's page as its provenance, and that page is live and names `reader` in its readers; otherwise when it is
  `world` or `worldOnly` is false, and, with `remoteFloor`, passes the same provenance-page check as
  `readRemoteForgetTier`. `expired_at` comes back as an ISO string, which the TypeScript member turns into a `Date`.
  The engines' `lock` (`FOR UPDATE`) changes nothing in the store: its transactions are serial.
- A copy of fact `u` is another active fact (no `expired_at`, `valid_until` unset or later than now) of `u`'s source
  and visibility whose claim has `u`'s fingerprint (`gbrain_fact_fingerprint`). `readLinkedFactCopies` keeps copies
  that name a non-null entity other than `u`'s, only `world` ones with `worldOnly`, and with `remoteFloor` only ones the
  floor of `readRemoteForgetTier` does not hide; ordered by id, at most five. `hasHiddenFactCopy` looks at every copy
  when `u` names no entity or an unbacked one, else at copies on `u`'s entity, and answers whether the floor hides one.
- `ownerReachesFact` answers for an owner with no member identity, whose read rule (`ownerReadPolicyFragment`) is
  `FALSE`: the fact belongs to the source, is not on a member page or the scope page, and no page record, a deleted one
  included, exists at its `source_markdown_slug` or `entity_slug`.
- `readFactWithdrawalClaim` reads the fact when it belongs to the source, is not an extraction outcome marker (an audit
  row source with the fixed marker text, `outcomeMarkerSql`), is `world`, or `private` on `memberPage`, or `worldOnly`
  is false, and, with `remoteFloor`, passes the floor of `readRemoteForgetTier`. `fact_hash` is
  `gbrain_fact_fingerprint(fact)`; `subject` is the slug of its owned memory page (a member page or the scope page),
  else `*` for no entity or an unbacked one, else the entity (`factWithdrawalSubjectSql`).
  With `lock`, PGLite and Postgres add `FOR UPDATE` (`recordFactWithdrawal` locks the claim it changes); the store
  takes no row lock, because it serializes writes and the withdrawal's `Store::write` is the lock.
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
  - `readForgetTarget` under `remoteFloor` (without `ownPage`), `readLinkedFactCopies` and `readFactWithdrawalClaim`
    under `remoteFloor`, and `hasHiddenFactCopy`, on the same terms;
  - `ownerReachesFact` for an owner bound to a member, whose pages GST-2490's owner read rule judges.

- Pinned by `test/engine-parity/memory-mutation-reads.test.ts` and `test/engine-parity/forget-reach-reads.test.ts` on every arm and by
  `crates/gbrain-store/tests/memory_mutation_reads.rs`.

## Not modelled yet

| Rule | What it judges | Where it renders | What Rust does |
| --- | --- | --- | --- |
| GST-2490's owner read rule (lineage) | the pages an owner bound to a member reaches: its own member page by readers, satisfied folder rules, lineage origins and the owner-only test, then the privacy part | `ownerReadPolicyFragment` (`src/core/search/private-visibility.ts`) | `ownerReachesFact` refuses (`engine_capability_missing`); TODOS.md `rust-owner-read-rule` |
