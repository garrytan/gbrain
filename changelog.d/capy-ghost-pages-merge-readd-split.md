---
important: data-loss
---
**`gbrain repair ghost-pages` and sync's opt-in deletion of held pages now keep a page whose file moved through a merge, onto a path used before, or in two commits.**

### Fixed
- When a merge commit rewrote another file to a deleted file's content, or added a new file holding it, `gbrain repair ghost-pages` did not see the move and could approve the old page for soft-delete. It now keeps that page as `move_unproven`.
- When a file moved onto a path that had been deleted earlier, and sync still held the old page at that path, `gbrain repair moved-pages` could fold the moved file's page into that older page, which never held the moved content. It now folds only once that page holds every line, the type, the tags and the frontmatter of the moved file's old page, and holds the pair `survivor_differs` until then.
- With `sync.apply_held_deletions` on, a file moved in two commits (the deletion first, then the add) could be deleted by a sync that ran between them, even when the deletion commit also changed other files. A sync now deletes only a page an earlier sync already held, so a later sync that sees the add keeps the page as `file_moved`.

### Changed
- With `sync.apply_held_deletions` on, a held page is deleted one sync later than before. On a checkout where nothing else changes, that later sync is the next commit or the daily full sync, so the page can stay live for up to about a day. If the add of a two-commit move lands after that later sync, the page is still deleted (restorable for 72 hours); a large catch-up that one `gbrain sync` runs as several passes can reach that later pass within the same command.

<!-- behavior-change: ghost_pages_merge_readd_split_gst3688 -->
