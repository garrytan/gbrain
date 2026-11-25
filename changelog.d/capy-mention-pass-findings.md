**Mention links stay right when a name leaves the entity list, and big brains check new names in batches.**

### Fixed
- When an entity name is retired (a page renamed, merged or no longer an entity), the mention pass now rechecks pages that contain that name even if they never linked to it, so a shorter name the retired one was hiding gets its link.
- The check for pages that contain a new or retired name reads pages in batches of 500, and for names written in plain ASCII it fetches page text only where the name can appear, so a large source no longer loads every matching page body in one statement.
- When a run has no time left to save a changed name list, mention coverage now reports the source as pending even with no page counted due yet, instead of complete.
