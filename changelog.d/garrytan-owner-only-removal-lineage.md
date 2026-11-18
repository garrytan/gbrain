**Pages and facts made from your iMessage conversations stay owner-only after the conversation is deleted or its source is removed.**

### Fixed
- Removing an iMessage source (`gbrain sources remove`, with or without `--keep-storage`), or deleting one of its pages for good, used to make every page, fact and concept derived from it readable by other members of a shared brain. A delete now records those derived rows first (migration v322, table `owner_only_marks`), and they stay owner-only. Nothing derived is deleted, and the owner still reads all of it.
- A row many derivations away from an iMessage page is now owner-only too. The earlier check stopped after 8 hops.
- A soft-deleted iMessage page, its restore, and its later purge keep the derived rows owner-only at every step.

### Changed
- A database role whose reads row-level security limits can no longer delete an owner-only origin; it gets `owner_only_lineage_unreadable`. Delete it as the role that owns the gbrain tables.
- New doctor check `owner_only_marks_triggers` names a delete trigger that is missing or disabled, with the fix. While one is missing on a brain that holds owner-only data, derived rows read as owner-only until the owner clears the `('*', 'unguarded')` mark. See docs/ENGINES.md, "Owner-only delete triggers".
