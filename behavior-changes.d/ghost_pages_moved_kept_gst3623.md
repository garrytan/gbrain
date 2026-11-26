---
kind: fix
---
gbrain repair ghost-pages no longer approves a page whose file moved to another live page for soft-delete: the preview lists it as moved_to with the gbrain repair moved-pages --source <id> --slug <slug> fold, which previews first, and keeps a page whose path Git renamed or copied without a proven fold as move_unproven. A database_ahead_of_file ghost now shows move evidence, matched or unmatched. gbrain repair moved-pages also folds a file renamed and edited in one commit, or a page edited in the database after its move, when the moved page holds every line of the old page in order, with its tags; a move whose lines changed stays held. Nothing is folded or deleted without a preview and its --expect hash.
