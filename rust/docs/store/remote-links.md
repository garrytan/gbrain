# The brain store: Remote links effect

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The reads and writes of the `links` effect of a remote page write (`src/core/persistence/effect-links.ts`, link_source
`mcp-remote-mention`) and the re-arm of a finished batch's `links` effects (`persistence/effect-journal.ts`
`queueLinksReconcile`). The TypeScript statements are in `src/core/engine-sql/remote-links.ts`; the store module is
`rust/crates/gbrain-store/src/remote_links.rs`, with the re-arm in `persistence/effect_worker.rs`; the addon methods
are in `rust/crates/gbrain-napi/src/families/remote_links.rs`. The family adds no keys: it reads links through the
origin index of `links.rs` and pages through `pages.rs`. Which targets get an edge stays with the effect.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| (TypeScript only) `setEffectTransactionLimits()` | nothing: the store has no lock wait or statement limit. Refuses `store_closed` on an ended transaction | `setEffectTransactionLimits` |
| `brain.readOwnedLinks(linkSource, originPageId)` | `[{ id, slug }]`: the edges whose `link_source` is `linkSource` and whose origin is the page, each with its target's slug, by link id (PGLite sets no order) | `readOwnedLinks` |
| `brain.deleteOwnedLinks(originPageId, linkSource, ids)` | how many of the edges among `ids` it removed; an edge another producer or another origin owns stays | `deleteOwnedLinks` |
| `brain.readLinkTargetPages(sourceId, slugs, policy, honorAliases)` | `[{ slug, readable, visible }]` for each live page of the source among `slugs`. `readable` is the writer's read policy (null: every page); `visible` is the privacy part alone (`privacyPartSql`, `privacy_allows`) | `readLinkTargetPages` |
| `brain.rearmLinksEffects({ sourceId, requestIds, slugs })` | how many `links` effects of the requests (of the slugs when given) it queued again: unclaimed, due now, error and outcome cleared, and marked `batch_reconciled`. An effect already marked or recovering is left. The store keeps no persistence protocol setting, so the protocol predicate always holds | `rearmLinksEffects` |

An id that is not a bigint refuses with `invalid input syntax for type bigint: "<id>"`.

The writer's read policy is gathered by `persistence/page-visibility.ts` (`writerReadPolicy`). The TypeScript member
renders it as PGLite renders it and serves it only when the text equals the no-caller member-access rendering or a fresh
record's rendering for the writer's one reader identity, with or without the owner flag; the store then judges each page
with `page_hidden` (facts/privacy.rs), as `readCallerPageAccess` does. The owner speaking for itself renders the identity
text without the owner-only clause, which the store reads as no owner-only test, the answer PGLite gives the owner.

Also served:

- A writer with no identity: a fresh record of its own folder coverage (sent as `folder_coverage` with `caller_record`, so the
  record's prefixes replace the store's live pending prefixes, as `coverageSql` reads them inside a record).
- One identity that satisfies folder rules, or whose record names pending prefixes: the same record with `satisfied_rule_ids` and
  `folder_coverage` (sent with `caller_record`), judged for that identity. A page stamped with a rule the writer does not satisfy
  (a retired stamp too, which `stamped_rules` keeps) is not readable; a page under a pending prefix is not readable.
- A labelled-only writer (`labelledOnly`, GBRA-108 design 1). `renderWriterReadPolicy` renders the rest of the policy ANDed with
  `labelledOnlyForSql`; the member checks the text is exactly those two parts, serves the rest as above, and sends the conjunct to
  the store as `labelled_only: { identity, satisfiedRuleIds }`, the two sets `labelledOnlySql` embeds (`labelledOnlyTerms`). The
  store hides a page unless its readers name one of `identity` (`page_readers && identity`, the `access_readers` normalization, a
  malformed `readable_by` names nobody) or a folder rule stamped on it is in `satisfiedRuleIds` (`folder_rule_ids && satisfied`,
  retired stamps included). No lineage: a write never reads through derived origins. So a labelled-only writer's rewrite of an open
  page, or of a page that names only other members, is `readable: false` and the remote write ends on `page_not_found`, as on PGLite
  and Postgres (`test/engine-parity/labelled-only-policy.test.ts`).

Any other writer (an owner record other than the owner speaking for itself, several identities, an empty policy object) refuses
`engine_capability_missing` before any read. The remote page write check (`authorizePageVisibility`) reads the live page against
the writer's policy through this member.

A labelled-only writer's create or capture of a new page still stops on `engine_capability_missing` on Rust, whether or not the page
names the writer: the slug has no live row, so `hiddenUnder` runs its raw fallback, and the create check reads the folder rules that
cover the slug through `gbrain_access_folder_rules`, which has no typed member. Nothing is written. This is the named loss
32e-b-3 (docs/designs/RUST_ENGINE.md), pinned in the same parity file.

An OAuth client writer (the HTTP transport) is not served: `readWriterSlugFence` refuses for `oauth_client`, since the
store keeps no OAuth client write grant yet.
