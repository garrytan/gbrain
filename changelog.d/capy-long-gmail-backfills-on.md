**A long Gmail backfill on a managed brain now keeps its progress as mail is saved, so a backfill that used to restart from the same spot every sync finishes.**

### Fixed
- When a Gmail backfill ran longer than the time a sync may wait for its pages to be saved, the sync stopped without recording how far back it had read. The next sync started from the same point, so on a large mailbox the backfill never finished. Each sync now records its position once the mail it covers is saved, and the next sync continues from there.
- The recorded position never moves past mail that failed to save or is still being saved, including mail an earlier sync left unfinished. That mail is read again on a later sync.
- A sync that saves a newer position no longer drops the note that recent mail is up to date, so the source stops looking stale once its mail is saved.

Reported by @PropFunderBrett (#9681)
