---
kind: fix
---
gbrain enrich and the autopilot thin-page phase now fill a page only from facts, link context and search hits that every reader of that page can already see. Before this release they also used private facts and text from pages that name fewer readers, and wrote the result onto the page under its own readers. Pages filled before this release keep their text: if you ran gbrain enrich or turned on cycle.enrich_thin on a brain with private pages or readable_by labels, review the pages whose frontmatter has enriched_by: cli:enrich and remove anything their readers should not see.
