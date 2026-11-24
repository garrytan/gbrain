---
kind: fix
---
gbrain repair ghost-pages now keeps a page whose content a merge commit rewrote another file to (move_unproven), and gbrain repair moved-pages holds a move onto a path deleted and added again as survivor_differs while that path's page is an older page sync still holds. With sync.apply_held_deletions on, a sync deletes only a page an earlier sync already held, so a held page is deleted one sync later than before and a file moved in two commits is kept as file_moved. Nothing extra is deleted.
