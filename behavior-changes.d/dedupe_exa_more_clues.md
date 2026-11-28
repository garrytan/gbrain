---
kind: add
---
If you turned on the opt-in Exa search for duplicate people (dedupe.exa on with EXA_API_KEY set), a person page with no company or job title can now send one query built from its name and an alternate work field (current_company, org, affiliation, works_at, headline), the name of a bare company website in domain or website, or the title of one visible company page it links with works_at. Pages that already had a query send the same one, so cached answers stay. Private, family or minor pages, contact details, URL paths and page text are never sent. gbrain dedupe classes --exa --dry-run lists what a live run would send and cost.
