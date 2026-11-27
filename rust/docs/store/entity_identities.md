# The brain store: Entity identities

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

An identity group joins pages of different sources that are the same person or company under one opaque
`entity_id` (migration v137, `entity_identities`). Links are manual. `src/core/entity-identity.ts` links, unlinks and
lists members, feeds the flag-gated link union and the referrer union (`src/core/mentions/referrers.ts`), and
`src/core/google/counterparty.ts` reads a page's canonical twin. The TypeScript statements are in
`src/core/engine-sql/entity-identities.ts`; the store module is `rust/crates/gbrain-store/src/entity_identities.rs`.

Keys (tag `i`, `keys::ENTITY_IDENTITY`):

- `i 0x01 <page id u64 BE>` holds the page's one membership as JSON: `entity_id`, `source_id`, `confidence`,
  `established_by`, `established_at_us`, `canonical`. The table's unique key is `(source_id, page_id)`, and a page has
  one source, so the page id alone keys it.
- `confidence` keeps every float8 value, as Postgres and PGLite do: a finite value is a JSON number, and NaN, Infinity and -Infinity are stored as that text, because JSON has no number for them. The shell sends a non-finite value as the same text and turns it back into a number on the way out, so `listEntityIdentityRows` answers NaN, Infinity or -Infinity as the SQL engines do. A record an older store wrote for a non-finite value holds null; it reads as NaN.
- `i 0x02 <entity_id> 0x00 <page id u64 BE>` is empty: the group index, one key per member.

A group has at most one canonical member, as the partial unique index on `entity_id WHERE canonical` keeps it. A
canonical link scans the group index, demotes the canonical member and writes the new membership in one
`Store::write`, as the SQL runs the demotion and the upsert in one transaction. The store keeps no separate canonical
key: groups are small, and one copy of the flag cannot disagree with itself.

The membership is keyed by page id, so a rename keeps it. A hard page delete drops it (`remove_page_rows`, called from
`cascade.rs`, the `ON DELETE CASCADE` of `page_id`). A soft delete keeps it; every read skips a soft-deleted member
until a restore. A source delete removes its pages first, so the family needs no source hook.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.linkEntityIdentity({ entity_id, slug, source_id, confidence, established_by, canonical })` | true when the live page at `(source_id, slug)` was linked; false, with nothing written, when there is no live page (the TypeScript member throws `identityPageNotFound`). Re-linking moves the page. `canonical` true demotes the group's canonical member; false clears the flag; null keeps it only when the page stays in the same group. `established_at` is the write time | `linkEntityIdentityRow` |
| `brain.unlinkEntityIdentity(entityId, slug, sourceId)` | true when the page at `(sourceId, slug)`, live or soft-deleted, was a member of `entityId` and was removed | `unlinkEntityIdentityRow` |
| `brain.listEntityIdentities({ entity_id, slug, slug_source_id, allowed_sources, exclude_private })` | `{ entity_id, source_id, slug, title, confidence, established_by, established_at, canonical }` rows of the live members the filters keep, by entity id, canonical first, source, then slug in byte order. Filters compose (AND). `slug` keeps the groups of a live seed page with that slug (in `slug_source_id` when given, in `allowed_sources` when given, and visible under the policy). `allowed_sources` limits members and seeds. `exclude_private` is the page policy (`page_hidden`, [facts.md](facts.md)); null keeps every page. `established_at` is an ISO string; the TypeScript member makes it a `Date` | `listEntityIdentityRows` |
| `brain.readEntityIdentityIdsForPages(sourceIds, slugs)` | `{ entity_id, source_id, slug }` of each live member whose source is listed and whose slug is listed (the cross product), by source then slug | `readEntityIdentityIdsForPages` |
| `brain.readCanonicalTwin(sourceId, slug)` | `{ slug, source_id }` of the live canonical members in another source of the live page's group, by source then slug, at most two | `readCanonicalTwin` |

Text that holds a NUL byte is `invalid_argument` in every member, as Postgres refuses a NUL in a text parameter.

The TypeScript `listEntityIdentityRows` member passes `excludePrivate` through `storePagePolicy` with
`callerReaders` (`src/core/rust-engine/store-members/private-provenance.ts`). A caller with a reader identity and a
private-readable grant is served. A caller whose policy differs in any other way (folder rules, pending coverage,
lineage, an owner read) gets the typed `engine_capability_missing` refusal. The callers rethrow that refusal
(`rethrowCapabilityMissing`) instead of reading it as "no identity".

Differences from PGLite:

- Order: the store sorts in byte order, as PGLite does. A Postgres database with a locale collation orders punctuation
  and case differently in the list (TODOS.md). The SQL leaves the order of `readEntityIdentityIdsForPages` and
  `readCanonicalTwin` to the plan; the store fixes it.
- The list's source filters are `= ANY($n::text[])` in the shared SQL; the store reads the same set.

## Known gaps

- Owner-only sources: `page_hidden` does not read them yet. While the brain has an owner-only source (an
  `owner_only` flag or an `imessage` kind), the TypeScript list member refuses a policy read typed rather than show a
  page of that source.

## Identity decisions

The owner's "same person" and "different people" verdicts on a group of pages (migration v325,
`entity_identity_reviews`; `gbrain dedupe`, `src/core/entities/identity-decisions.ts`) and the duplicate finder's read
(`src/core/entities/duplicates.ts`). The TypeScript statements are in `src/core/engine-sql/entity-keys.ts` and
`src/core/engine-sql/identity-decisions.ts`; the store module is `rust/crates/gbrain-store/src/identity_reviews.rs`.

Keys: `i 0x03 <decision_id>` holds one decision as JSON (`verdict`, `members` as given, `group_id`, `entity_id`,
`canonical_source_id`, `canonical_slug`, `decided_by`, `decided_at_us`, `origin`, `home_source_id`, `git_blob`,
`evidence`; a record without `evidence` reads as null). A
decision names its pages by `(source_id, slug)`, so a page delete or rename leaves it alone, as the table has no
foreign key. An apply runs in one `Store::write`: the decision rows and the `dedupe:confirm` memberships change together
or not at all, and applies run one at a time (the advisory lock of the SQL).

The company sweep's automatic groups (`established_by` `dedupe:auto`, `src/core/entities/company-auto-link.ts`) are
written by the same apply; the store module is `rust/crates/gbrain-store/src/identity_auto.rs`. A row's `generation` is
the page's real `pages.generation` (`page_generation.rs`), the counter the SQL engines' trigger keeps, so an automatic
group's pin (`p.generation = pl.generation`) compares what Postgres compares: it is equal while no watched column of the
page changes, and unlike the `knowledge_revision` token it replaced, a tag change does not move it.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listEntityKeyRows({ types, keys, after, limit, members, tokens })` | `{ source_id, slug, title, type, keys, page_id, generation, created_at, identity }` for live, unretired (`retiredPageSql`, `cli_reads::entities::is_retired`) pages of `types` in sources that exist and are not archived, strictly after `after` by `(source_id, slug)` in byte order, at most `limit`. `keys` holds the named frontmatter keys the page carries, a JSON null value included. `members` (when not null) keeps only those `(source_id, slug)` pages; `tokens` keeps pages one of whose `fields` values (an array's items, a string, a number's text) reads as one of `values` in a form the finder's key normalizers produce: the lowered, space-trimmed value, without leading `@`, its host (scheme and one `www.` dropped, cut at `/ ? # :`), the name after `/company/`, `/in/` or `/pub/`, or the login after `github.com/` (each cut at `/ ? #` and a space). `created_at` is ISO 8601 UTC with microseconds; `identity` is `{ entity_id, established_by }` of the page's membership in its own source, or null `collapsed` (master #10313; default false) replaces the live-unretired rule with the retired pages a dedupe collapse made: a `dedupe_collapse` key (a JSON null value counts) and a `merged_into` value that is not blank (`cli_reads::entities::is_collapsed`). | `listEntityKeyRows` |
| `brain.listIdentityDecisions()` | `{ decisions, pending, revision }`: decisions by id, `decided_at` as `timestamptz::text`, `evidence` as stored or null, `canonical` null unless both parts are non-empty; pending names each member of a "same" decision whose page is missing (`page_missing`), sits in no group (`unlinked`, when the decision has a group) or in another group (`other_group`), by decision id, source, then slug. `revision` is `decisionsRevision` | `listIdentityDecisions` |
| `brain.listRestrictedIdentityMembers(members, policy)` | the members whose page, live or soft-deleted, the page policy hides, once per matching input pair, in input order. The TypeScript member sends the no-caller policy of `privatePagesFilterFragment` | `listRestrictedIdentityMembers` |
| `brain.applyIdentityDecisions({ upsert, remove, expect_revision, auto })` | `{ upserted, removed, linked, unlinked }` plus `auto: { linked, unlinked, skipped }` when `auto` is given, or `stale: true` with nothing written when `expect_revision` is not the revision now. It removes, then upserts (`decided_at` null takes now; `evidence` is kept when not empty, else null). It then deletes the `dedupe:auto` rows of the groups `auto.unlink` names and of every automatic group a "same" decision's member sits in or that holds two members of one "different" decision; writes each planned `auto.link` group (confidence 1, the `canonical_page_id` member canonical) only when every member page exists live in its source at the planned generation and sits in no other group, skipping members already linked; and deletes every automatic group left with fewer than two rows, no canonical row, or a member page that is gone or soft-deleted (counts are of distinct groups; `skipped` counts the planned groups that failed that check). Then it deletes every `dedupe:confirm` membership no "same" decision's live member backs, links each live member page that sits in no group (per group the first, canonical first then decision id, source and page id, is canonical when it is the decision's canonical member and the group had none), then marks the first decision's canonical member canonical when its group still has none. Memberships any other actor wrote are never touched. A verdict other than same or different, an origin other than database or git, or a `decided_at` that is not a timestamp (an ISO time, or the `timestamptz::text` the list returns, with its zone), non-ASCII text included, is `invalid_argument` before any write, as the SQL cast refuses it | `applyIdentityDecisions` |
