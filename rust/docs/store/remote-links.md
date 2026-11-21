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
record's rendering for the writer's one reader identity; the store then judges each page with `page_hidden`
(facts/privacy.rs), as `readCallerPageAccess` does. Any other writer (folder rules, an owner record, a labelled-only
grant, several identities, an empty policy object) refuses `engine_capability_missing` before any read.

An OAuth client writer (the HTTP transport) is not served: `readWriterSlugFence` refuses for `oauth_client`, since the
store keeps no OAuth client write grant yet.
