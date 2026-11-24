---
kind: add
---
gbrain dedupe classes counts the pairs of person pages that might be one person by their evidence (shared email, phone or account id, your email and chat pages, and an opt-in Exa web search), and gbrain dedupe sample --class <c> exports a seeded random sample of one class to check by hand. Both only read; nothing is linked. Web search is off until you set EXA_API_KEY and run gbrain config set dedupe.exa on; it sends only a name plus one company or job title, never for a page not every reader may read or a family or minor page, caches every answer and stops at dedupe.exa_run_cap (2,000) and dedupe.exa_total_cap_usd ($25). Run gbrain dedupe classes --exa --dry-run to see the cost first.
