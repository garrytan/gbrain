---
kind: fix
---
A synthesis cycle that finds a concept unchanged now also replaces the concept's recorded derivation inputs with its current member atoms, so a stale record an older version left is cleared without a re-synthesis, and purging the retired former member no longer hides the concept (#9653). The cycle skips the refresh when the concept changed after it was read. A brain that never runs synthesis, or a concept whose group no longer forms (#9652), keeps its record; doctor concept_stale_inputs counts those.
