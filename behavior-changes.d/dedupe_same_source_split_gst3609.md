---
kind: fix
---
The duplicate finder (gbrain dedupe --preview, doctor entity_duplicates) now also lists two or more same-name pages of one source as their own in_source group when they sit in a cross-source group, so they show up for collapsing. Before, they appeared only inside the cross-source group, and gbrain dedupe confirm on that group would have linked two pages of one source as one identity. Now confirm refuses such a group (reason same_source_members) and the confirm list leaves it out: collapse the same-source pages first, and the next preview shows the cross-source group with one page per source. Nothing is linked, merged or edited by this change.
