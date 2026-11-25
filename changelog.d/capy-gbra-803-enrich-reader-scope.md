---
important: security
---
**Filling a thin page (`gbrain enrich` and the autopilot thin-page phase) now uses only facts, link context and search hits that every reader of that page can already see.**

<!-- behavior-change: enrich_evidence_page_readers_gst3815 -->

### Fixed
- Enrichment gathered its evidence with no reader check: every fact about the entity (private facts and facts held on pages that name fewer readers included), the context of every link into the page and every search chunk that mentioned it. The model's text was then written onto the page under that page's own `readable_by` and `visibility`, so something only some readers could see could be copied onto a page more people read. Evidence is now limited to world facts whose holding and source pages every reader of the target page reads, and to link context and search chunks from such pages. A page that names readers still gets facts from pages whose readers include all of its own, and a page's own world facts are used as before. Private facts are never used. This works the same on a brain with no git repository.
