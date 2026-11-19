# The brain store: Page operations

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.
These methods work on the pages of [Pages](pages.md) and add no keys of their own (family tag `p`).

Every date is an ISO string with microseconds (`2026-08-10T12:00:00.000123Z`) or `null`; the
TypeScript members turn them into `Date` where PGLite returns one. Text sorts in byte order.
There are no secondary indexes yet: each method scans the pages of its scope.

A read scope (`PageReadScope`) is `{ sourceId?, sourceIds?, live?, excludePrivate? }`. A non-empty `sourceIds`
wins over a non-empty `sourceId`; with neither, every source. `live: true` also hides deleted pages,
pages whose frontmatter has a `quarantine` key and pages of a missing or archived source. The
TypeScript members send `live: true` whenever the caller passes a scope object, and refuse
`engine_capability_missing` for a truthy `minTrust` or `suppressFlagged`.

`excludePrivate` is the page policy `pageReadFilter` adds, as `facts/privacy.rs` `page_hidden` reads it
(`{ honorAliases, entityPrivacy, ownerOnly }`, as `resolveAliases` takes it): a page the policy hides is not read,
an owner-only page (a page of an owner-only source, or under the closed form any page of a brain that holds one) included. The
TypeScript members `getContentFlagsByPageIds`, `getUnverifiedExtractionPageIds` and `getEffectiveDates` send it
from a truthy `excludePrivate` through `storePagePolicy`, which refuses a caller whose policy is wider than the
store's. They also accept and ignore the other keys of hybrid search's option bag (its settings, callbacks and
`takesHoldersAllowList`), because hybrid search hands them that whole bag as their policy; any other key still
refuses.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getContentFlagsByPageIds(ids, scope?)` | `[{ id, reason, detail }]` of pages whose frontmatter `content_flag.reason` is a non-empty string | `getContentFlagsByPageIds` |
| `brain.getUnverifiedExtractionPageIds(ids, scope?)` | `[{ id, status, unverified }]` of pages with a frontmatter `status`; `unverified` is `status = 'unverified'` and `provenance = 'auto-extracted'` | `getUnverifiedExtractionPageIds` |
| `brain.getPageTimestamps(slugs)` | `[{ slug, ts }]` (`ts` = `updated_at`) of every page with that slug, deleted included, in page id order | `getPageTimestamps` |
| `brain.getEffectiveDates(refs, scope?)` | `[{ source_id, slug, ts }]` (`ts` = `effective_date`, else `updated_at`) for each ref that names a page | `getEffectiveDates` |

Only the marker and date reads are built so far (hybrid search reads them). The other page operations
still refuse with `engine_capability_missing`. `getPageTimestamps` is a store method only: it has no
binding or TypeScript member yet.
