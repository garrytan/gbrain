---
kind: fix
---
A new file whose page slug (its path without .md, or its slug: line) is over 255 characters is now held by sync as slug_too_long, and skipped by gbrain import, instead of being stored under a slug that no later read, write, delete or repair accepts; the rest of the source syncs. Move the file to a shorter path and commit to clear the hold. A page an older sync already stored under such a slug keeps syncing and reindexing, and can now be deleted, restored and purged with gbrain delete and gbrain restore, database-only.
