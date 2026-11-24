---
important: data-loss
---
**`gbrain repair ghost-pages` and sync's opt-in deletion of held pages now keep a page whose file moved through a merge, onto a path used before, or in two commits.**

### Fixed
- When a merge commit rewrote another file to a deleted file's content, `gbrain repair ghost-pages` did not see the move and could approve the old page for soft-delete. It now keeps that page as `move_unproven`.
- When a file moved onto a path that had been deleted earlier, and sync still held the old page at that path, `gbrain repair moved-pages` could fold the moved file's page into that older page, which never held the moved content. It now holds the pair `survivor_differs` until sync imports the move.
- With `sync.apply_held_deletions` on, a file moved in two commits (the deletion first, then the add) could be deleted by a sync that ran between them. A sync now deletes only a page an earlier sync already held, so the later sync sees the add and keeps the page as `file_moved`.

<!-- behavior-change: ghost_pages_merge_readd_split_gst3688 -->
