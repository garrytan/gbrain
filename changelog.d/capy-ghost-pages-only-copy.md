---
important: data-loss
---
**`gbrain repair ghost-pages` no longer deletes pages that hold the only copy of their content: it removes a page only when a commit deleted its file.**

<!-- behavior-change: ghost_pages_only_copy_gst3637 -->

### Fixed
- `gbrain repair ghost-pages` approved any page whose file was missing for a soft-delete, which autopilot purges after 72 hours. That included pages whose file no commit ever held and pages whose file was only deleted in the working tree, so the page could be the only copy of its content. The preview now lists those pages apart, with a route to restore each, and never approves them: `ghost_never_committed` (write the file from the page with `gbrain repair file-drift --prefer database`, then commit and sync), `ghost_worktree_only` (`git checkout -- <path>` and sync, or commit the deletion) and `ghost_history_unknown` (Git cannot say which commit deleted the file). The apply refuses them too, so an approval saved before upgrading keeps the page.
- `gbrain repair file-drift --prefer file` reads the same check and skips those pages with the same codes.
- The route printed for a missing file whose history is still in HEAD, or unknown, now says to restore the file or commit the deletion, instead of pointing at `repair ghost-pages`.
