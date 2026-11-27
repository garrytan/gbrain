# The brain store: Guest promotions

Part of the store contract in [rust/README.md](../README.md) ("The brain store"): the rules there apply to every method here.

These were statements `promote_guest_note` (`src/core/guests/promote.ts`), a remote delete of a guest note
(`src/core/guests/admission.ts` `refuseRemoteGuestDelete`) and the guest stamp (`src/core/guests/stamp-readable.ts`
`readableGuestRefs`) ran through `executeRaw`. The TypeScript statements are in `src/core/engine-sql/guest-notes.ts`; the
store module is `rust/crates/gbrain-store/src/guest_promotions.rs`.

Keys: `keys::GUEST_PROMOTION` (`~p`, a two-byte family tag), then the guest page id (8 big-endian bytes), the target
source, `0x00` and the target slug, holds the row as JSON `{id, promoted_by_kind, promoted_by_id, promoted_at_us,
request_id?}`. One row per guest page and target, as the unique index `guest_promotions_link_key`; `id` comes from the
counter `next_guest_promotion_id`. A guest page deleted for good takes its rows with it (`cascade::remove_page_rows`, the
foreign key's `ON DELETE CASCADE`); the target is text, so a purge of the target page keeps the row.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.linkGuestPromotion({guestPageId, targetSource, targetSlug, byKind, byId, requestId})` | nothing. The row of that guest page and target gets the new promoter, time (now) and request, or is written with the next id. A guest page that does not exist is `constraint_violation` and writes nothing. Text holding a NUL byte is `invalid_argument` | `linkGuestPromotion` |
| `brain.readGuestPromotionKept(guestPageId, targetSource, targetSlug)` | whether that row exists and a page, live or soft-deleted, is at the target | `readGuestPromotionKept` |
| `brain.readGuestDeleteCheck(sourceId, slug)` | `{hidden: false, guest, kept, writer}` for the page at the key, live or soft-deleted: whether its source has a guest record ([guest_sources.md](guest_sources.md)), whether it has a promotion row, and its mark's `kind:id` ([guest_marks.md](guest_marks.md)) or null; null with no page there | `readGuestDeleteCheck` |
| `brain.readGuestRefPages({ids, keys, exclude_private})` | `{id, source_id, slug, type, frontmatter}` of each page, live or soft-deleted, with an id in `ids` or a `{source_id, slug}` in `keys`, once each, by page id; under `exclude_private` only a page the page policy admits (`facts/privacy.rs` `page_hidden`). The TypeScript member passes the caller's policy through `storePagePolicy` with caller readers | `readGuestRefPages` |

The rows are also read by `readGuestMarks` (`promoted`) and the concept rebuild's attachment kinds (`guest_promotions`).
The seed copies `guest_promotions` rows after the pages (seed/privacy.rs) and raises the id counter past each row's id;
the shadow follower removes a row by its `id`.

Not reachable: `hidden` true. On Postgres a role that row-level security keeps from reading `guest_sources` reads it
true and guest admission refuses with `writer_coordinator_required`; the store has no roles (named loss 32m-5 of
docs/designs/RUST_ENGINE.md).
