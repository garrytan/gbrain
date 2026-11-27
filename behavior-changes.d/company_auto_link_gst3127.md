---
kind: add
---
gbrain now links companies that are plainly one company across sources without asking: after each sync, cross-source company pages with exactly the same name that share a LinkedIn company page or their own site's domain, share an id no other page has, and name no different countries are linked as one identity (established_by dedupe:auto), which rankings and enrichment count once. Pages written by gbrain import, put_page or capture link at the next sync or reconcile. Run gbrain dedupe reconcile once to link the companies already in your brain. gbrain dedupe reject <identity> removes a wrong link and keeps that pair apart, even after a rename or a move to another source. People are never linked automatically, and no page is merged, renamed or deleted.
