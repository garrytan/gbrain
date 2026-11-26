---
kind: fix
---
The history import gbrain setup runs checks the brain's audience again before it publishes each day: when a member is added while it runs and the brain turns shared, it stops with archive_audience_changed before the next day is written, and the pages already written are kept to the owner. Rerun gbrain transcripts archive run once the member change is done. Ordinary gbrain transcripts archive run and backfill runs are unchanged: they still read the audience once, under the archive run lock.
