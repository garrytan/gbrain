---
important: data-loss
---
**Purging a retired atom no longer hides concepts rebuilt without it but still hides every saved version written with it, and `embedding_disabled` now stops every route that sends text to the embedding provider.**

<!-- behavior-change: concept_inputs_replaced_9653 -->
<!-- behavior-change: concept_inputs_refreshed_by_cycle_9653 -->
<!-- behavior-change: embedding_disabled_rechecks_9715 -->

### Fixed
- Purging an atom a concept no longer used soft-deleted that concept, because the concept still recorded every atom it had ever been built from. A concept's recorded inputs are now replaced with its current members each time it is re-synthesized, and a synthesis cycle that finds a concept unchanged clears an older version's stale record without a model call, so one cycle fixes every concept whose group still forms. A concept still built from the purged atom is hidden, as before. Reported by @ikatsura (#9653).
- The same purge now also hides each saved version of a concept that was written while the purged atom was one of its inputs: `get_versions`, `get_page` with `known_as_of` or `as_of`, and `revert_version` stop returning it. Nothing deletes a version, and the purge errs toward hiding: an older version archived before that atom joined the concept is hidden too. Callers that may not read owner-only material also stop seeing versions written from owner-only inputs; the owner's own callers still read every version a purge did not hide. Reverting to such a version brings its inputs back onto the live page, so the restored text stays hidden from the same callers, and a hidden version's change reason is withheld from the version before it.
- A brain that never runs synthesis, and a concept whose group no longer forms (#9652), keep their stale records; doctor `concept_stale_inputs` counts them.
- A contextual reindex job queued before `embedding_disabled` was set now sends nothing when the worker runs it, and one already running checks again before each send, and a `gbrain reindex-multimodal` already running stops before its next batch with the enable-command message. With these, `embedding_disabled` stops every route that sends text to the embedding provider. When the database setting can't be read, the contextual reindex job, the `doctor --remediate` embed step and `gbrain serve`'s background embed still send nothing, and now keep the work pending and try again later instead of counting it as done (#9715).
