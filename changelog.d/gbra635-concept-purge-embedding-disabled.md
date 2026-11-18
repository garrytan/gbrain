---
important: security
---
**`embedding_disabled` now stops the routes that still sent text to the embedding provider.**

<!-- behavior-change: embedding_disabled_every_route_9715 -->

### Fixed
- With `embedding_disabled` set (in the config file or the database), the synthesize phase-end embed, the safe-chunks, contextual-mode and secret-spans repairs, the `doctor --remediate` embed step, imports run by derived writers (concepts, patterns, enrichment), code and image imports, extract_facts' fence facts, `reindex-code`, the grounding check and brainstorm's question still sent text to the embedding provider. They now send nothing. `gbrain embed` and its sync, connector and auto-fix callers also refuse when only the database says embedding is off, and `gbrain reindex-multimodal` refuses with the same enable-command message. If the database setting can't be read, these routes now treat embedding as off instead of on, and `gbrain serve` stops retrying its background embed on such a brain. Reported by @DaCal90 (#9715).
- Not covered yet: a contextual reindex queued before the setting was turned on, and a `reindex-multimodal` run already in progress; both are fixed in a later release.
