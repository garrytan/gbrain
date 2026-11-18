---
kind: fix
---
A concept publication now replaces the concept's recorded derivation inputs with its current member atoms, so purging a retired former member no longer hides a concept that was re-synthesized without it (#9653). Doctor concept_stale_inputs counts live concepts an older version left with an input edge to a deleted former member; nothing rewrites them, and each is corrected the next time it is re-synthesized with changed members.
