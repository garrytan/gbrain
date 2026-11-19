---
important: data-loss
---
**The automatic purge no longer permanently deletes a concept that was hidden only because one of its inputs was purged.**

<!-- behavior-change: automatic_purge_keeps_rederive_concepts_9653 -->

### Fixed
- When an atom was purged, the concept built from it was hidden for rebuilding, but no rebuild came, and the automatic purge removed the concept about 72 hours later with its history and incoming links. The cycle's purge phase, `gbrain maintain` and the purge job now keep such a concept until it is rebuilt. A concept a person or a sync deleted still expires on time, and an explicit `gbrain pages purge-deleted --yes` or `gbrain delete --purge` still removes it (#9653).
