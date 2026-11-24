---
important: data-loss
---
**`gbrain repair ghost-pages` and sync's opt-in deletion of held pages now keep a page whose file moved in the cases the previous fix missed.**

### Fixed
- When the commit that deleted a file also rewrote another file to the deleted file's content, `gbrain repair ghost-pages` did not see the move and could approve the old page for soft-delete. It now lists that page as `moved_to` (or `move_unproven`), and `gbrain repair moved-pages` can fold it once the rewritten file's page holds the old page's lines (until sync imports the rewrite, it is held `survivor_differs`). A symlink replaced by the moved content counts too, and so does a rewrite committed before the deletion.
- A ghost page with more than five same-name files elsewhere in the source was treated as having no linked file, because the preview reads history for at most five. It is now kept as `move_unproven` instead.
- A move committed after a ghost-page soft-delete was prepared, but before it was written, slipped past the move check. The soft-delete now checks again when a commit landed in between.
- With `sync.apply_held_deletions` on, sync deleted a held page without checking whether its file moved. A page whose file moved now stays held, with `meta.held_deletion.refused` set to `file_moved`; when Git cannot read whether it moved, the next sync checks again. If a commit lands between the move check and the deletion, the deletion waits for a later sync to check it at the new commit, and the rest of that sync still goes through.

### Changed
- The move check reads the history of every ghost's last committed content in one pass per run instead of once per ghost. On a synthetic repository with 3,000 commits and 100 moved pages, the `gbrain repair ghost-pages` preview went from 31 seconds to 16.

<!-- behavior-change: ghost_pages_move_gaps_gst3648 -->
