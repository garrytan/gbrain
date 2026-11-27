# The brain store: Guest marks

Part of the store contract in [rust/README.md](../README.md) ("The brain store"): the rules there apply to every method here.

These were statements a guest note's publication (`src/core/guests/admission.ts`) and the guest stamp
(`src/core/guests/marker.ts`) ran through `executeRaw` on the `guest_marks` table (`src/core/guests/schema.ts`). The
TypeScript statements are in `src/core/engine-sql/guest-notes.ts`; the store module is
`rust/crates/gbrain-store/src/guest_marks.rs`.

Keys: `keys::GUEST_MARK` (`~g`, a two-byte family tag), then the page id (8 big-endian bytes), holds the page's one mark as
JSON `{source_id, slug_at_write, audience_member, group_slug, sender_label, saved_at_us, writer_kind, writer_id, request_id?,
created_at_us}`. A page deleted for good takes its mark with it (`cascade::remove_page_rows`, the table's `ON DELETE
CASCADE`); a soft delete keeps it.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.insertGuestMark({sourceId, slug, audienceMember, groupSlug, senderLabel, writerKind, writerId, requestId})` | how many rows it wrote: 1 for the page at `(sourceId, slug)`, live or soft-deleted, saved and created now; 0 when no page is there. A page that already has a mark is `constraint_violation` (`guest_marks_pkey`) and writes nothing. Text holding a NUL byte is `invalid_argument` | `insertGuestMark` |
| `brain.readGuestMarks(pageIds)` | `{page_id, sender_label, group_slug, audience_member, saved_at, writer_kind, writer_id, promoted}` for each page id that has a mark, once each, by page id; `saved_at` is ISO time. `promoted` is false | `readGuestMarks` |

`claimGuestNotePublication(sourceId, requestId)` has no store method of its own: the Rust engine reads the source's guest
row (`readGuestSourceRow`, [guest_sources.md](guest_sources.md)) and, when there is one, sets `gbrain.guest_note` in the
store's write trust settings for the rest of the transaction (`applyWriteTrust`), as the SQL statement's `set_config` does.
The store serializes its writes, so the SQL statement's share lock has nothing more to hold.

The seed copies `guest_marks` rows after the pages (seed/privacy.rs), and the shadow follower removes a mark by its page id.

Not served: the store keeps no `guest_promotions`. Promoting a guest note, the remote guest delete check and the remote read of
guest refs still run raw SQL and refuse typed on this engine (row 32m-4 of docs/designs/RUST_ENGINE.md).
