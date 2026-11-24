---
important: security
---
**The conversation archive no longer leaves pages any member can read when a brain turns shared while an archive run is starting or still running.**

### Fixed
- An archive run read the brain's audience (personal or shared, and the owner) before it took its source's run lock. A `gbrain access member add` (or `gbrain config set brain.audience shared`) that finished in that gap kept the earlier pages to the owner, but the run then wrote its new pages with no readers, so the new member could read them, and it recorded the brain as personal again. The run now reads the audience and the archive switch again once it holds the lock, so its pages are kept to the owner and a brain whose unset switch now resolves off archives nothing.
- When the new audience moves the run to another source (on a shared brain, a checkout source's archive goes to its database-only `<source>-owner` source), the run writes nothing and ends with the new retryable code `archive_audience_changed`; the maintenance pass records it as a skip, and the next run archives into the owner-only source.
- A run that started on the personal brain and was still writing when the brain turned shared left its later pages for the next run to keep to the owner (`archive_rescope_pending`). An archive run into a checkout source's `<source>-owner` source, or one that found the archive off, could record the brain as shared in the meantime without holding that source's run lock, so the next run skipped the re-scope and those later pages stayed open to every member. The audience is now recorded only while the source's run lock is held; while another run holds it, the owner-only rules apply and the re-scope stays pending for the next run.
