---
important: security
---
**The conversation archive no longer writes pages any member can read when a brain turns shared just as an archive run starts.**

### Fixed
- An archive run read the brain's audience (personal or shared, and the owner) before it took its source's run lock. A `gbrain access member add` (or `gbrain config set brain.audience shared`) that finished in that gap kept the earlier pages to the owner, but the run then wrote its new pages with no readers, so the new member could read them, and it recorded the brain as personal again. The run now reads the audience and the archive switch again once it holds the lock, so its pages are kept to the owner and a brain whose unset switch now resolves off archives nothing.
- When the new audience moves the run to another source (on a shared brain, a checkout source's archive goes to its database-only `<source>-owner` source), the run writes nothing and ends with the new retryable code `archive_audience_changed`; the maintenance pass records it as a skip, and the next run archives into the owner-only source.
