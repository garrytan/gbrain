**A managed sync no longer re-reads every page when another writer keeps committing.**

### Fixed
- When another writer commits during a managed `gbrain sync` pass, the pass re-reads only the database rows that changed since its previous round, instead of every page and import record. The next pass reuses the last read the same way after a pass that stopped early and can resume, not only after one that finished. So each pass stays cheap, and a short pause in commits is enough for the sync to catch up.
- `gbrain sync status --json` reports `convergence.levels`: how many commits the newest pass read, and how many of its rounds read the pages in full or patched the previous read. The sync progress line says when a round patched the previous read.
