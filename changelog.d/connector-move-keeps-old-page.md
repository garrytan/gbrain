---
important: data-loss
---
**A renamed contact or a moved calendar event no longer deletes its only page when the replacement cannot be saved.**

### Fixed
- When a contact in Google Contacts or Apple Contacts is renamed, the sync writes the page under the new name and then removes the old one. If the new page could not be saved because its content matches a page you purged, or the import kept the page under its old name, the old page was still removed, and the contact was left with no page at all. The old page is now removed only after a page under a different name has actually been saved. Apple Contacts also leaves the contact's person link and its facts as they were when no new page was saved.
- When a Google Calendar event's title or date changed, the sync removed the old event page before writing the new one. If the new page failed to import, matched a purged page, or kept the old name, the only copy of the event was gone. The sync now writes the new page first and removes the old one only after a page under a different name was saved, and a failed write is retried on the next sync. Cancelled events and events that move out of the sync window are removed as before.

Reported and first fixed by @jack60612.

Supersedes #10579
Supersedes #10577
