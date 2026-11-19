---
important: data-loss
---
**A concept hidden because one of its inputs was purged now comes back, rebuilt from the inputs it still has.**

<!-- behavior-change: concept_rebuild_after_input_purge_9653 -->

### Fixed
- When an atom was purged, the concept built from it was hidden and nothing ever rebuilt it. The next concept synthesis now rebuilds such a concept from its current members, under the same page id and slug and with the links other pages make to it. Nothing of the old text survives: old versions, chunks, tags, takes, timeline rows, outgoing links, the link dates the old body stated and its pending fact reviews are cleared in the same transaction, and on a managed brain so are its stored write intents. The rebuilt page keeps the hidden page's access labels, and the rebuild checks at commit that nobody who could not read the hidden page can read the new one, that the concept is still held and that its members are unchanged since their text was read; otherwise it writes nothing and the concept stays hidden. A concept a person or a sync deleted stays deleted, and a failed model call leaves the concept hidden until the next cycle (#9653).
- `gbrain maintain --purge`, `gbrain pages purge-deleted --dry-run` and the cycle's purge phase name the concepts waiting for a rebuild.
- Deleting a page that was already deleted now reports when it can really be purged (its first delete plus `purge.retention_hours`), instead of "now + 72h".

Known limit: on a brain where concept synthesis never runs or has no model key, a concept hidden this way stays hidden; the purge preview says so.
