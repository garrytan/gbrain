---
kind: fix
---
Imported-transcript trust (a speaker_owner marker being honored, and gbrain transcripts accept-fences) now follows who wrote the page's current text, recorded on the page itself. A page a remote agent edited, replaced, appended to or uploaded over stays untrusted through later tag changes, re-embedding and maintenance; running the importer on that session again restores it. The upgrade stamps existing importer and connector pages that no remote writer touched, so they stay trusted. A local write into an iMessage, Google or Meetings source that is not that connector's own sync no longer counts as the connector's.
