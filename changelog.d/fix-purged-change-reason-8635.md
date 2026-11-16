---
important: security
---
**A purged claim no longer comes back as a page's change reason when a sync publishes after the purge.**

### Fixed
- A sync reads each page's change reason from its `gbrain-reason` commit trailer before it saves the page. If a fact purge committed in between, the saved page history still stored the purged text as that page's reason. The save now checks the purge's tombstone for the exact commit and file when it writes the history row, so the reason is stored empty, while the page content still imports and other files' reasons from the same commit are kept. This applies to classic and managed sync (#8635, #8591).

<!-- behavior-change: purged_change_reason_8635 -->
