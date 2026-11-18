---
important: data-loss
---
**A synthesis cycle now clears the stale concept input records an older version left, so purging a retired atom stops hiding concepts that no longer use it.**

<!-- behavior-change: concept_inputs_refreshed_by_cycle_9653 -->

### Fixed
- A concept an older version left recording a retired former member was still hidden by that member's purge until the concept was re-synthesized with changed members. The synthesis cycle now replaces an unchanged concept's recorded inputs with its current members when they differ, with no publication and no model call, so one cycle clears these records for every concept whose group still forms. A concept still built from an atom is hidden by that atom's purge, as before. A brain that never runs synthesis, and a concept whose group no longer forms (#9652), keep their records; doctor `concept_stale_inputs` counts them. Reported by @ikatsura (#9653).
