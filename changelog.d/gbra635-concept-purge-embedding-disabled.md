---
important: data-loss
---
**Purging a retired atom no longer hides concepts that were rebuilt without it, and `embedding_disabled` now stops every route that sent text to the embedding provider.**

<!-- behavior-change: concept_inputs_replaced_9653 -->
<!-- behavior-change: embedding_disabled_every_route_9715 -->

### Fixed
- A concept re-synthesized from new atoms kept a record of every atom it had ever been built from, so purging a retired former member soft-deleted the live concept and marked it for re-derivation. Each concept publication now replaces that record with its current members. A concept still built from a purged atom is hidden as before. Concepts an older version left with a stale record are counted by the new doctor check `concept_stale_inputs`; nothing rewrites them, and each is corrected the next time the concept is republished. Reported by @ikatsura (#9653).
- With `embedding_disabled` set (in the config file or the database), the synthesize phase-end embed, the safe-chunks, contextual-mode and secret-spans repairs, the `doctor --remediate` embed step, imports run by derived writers (concepts, patterns, enrichment), code and image imports, extract_facts' fence facts, `reindex-code`, the grounding check and brainstorm's question still sent text to the embedding provider. They now send nothing. `gbrain embed` and its sync, connector and auto-fix callers also refuse when only the database says embedding is off, and `gbrain reindex-multimodal` refuses with the same enable-command message. If the database setting can't be read, these routes now treat embedding as off instead of on, and `gbrain serve` stops retrying its background embed on such a brain. Reported by @DaCal90 (#9715).
