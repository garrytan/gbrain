---
kind: fix
---
gbrain repair ghost-pages now keeps a page whose content a merge commit rewrote another file to or added as a new file (move_unproven), and gbrain repair moved-pages folds a move onto a path deleted and added again only when that path's page holds every line, the type, the tags and the frontmatter of the old page (else survivor_differs). With sync.apply_held_deletions on, a sync deletes only a page an earlier sync already held, so a file moved in two commits is kept as file_moved when the add lands before that later sync. A held page is now deleted one sync later than before; on a checkout where nothing else changes that is the next commit or the daily full sync, up to about a day. Nothing extra is deleted.
