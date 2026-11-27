---
kind: fix
---
Remote callers no longer count private pages they cannot read in pending_pages. The mention coverage that get_backlinks, the entity card, entity-names and a search naming an entity report (`state`, `pending_pages` and the `mention_index` notice) now counts only the pages a remote caller may read, so a new private page no longer raises a remote caller's pending_pages or turns a complete index pending. Local CLI callers count every live page, as before. One case stays: when a private page's name changes, the index reads pending for every caller until the next mention pass.
