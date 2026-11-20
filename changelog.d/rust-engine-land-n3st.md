**Core memory, the trust scan, belief history, the re-derivation check, search's title lookup and withdrawal discovery's page scans now run their queries through engine members.**

### Changed
- Thirteen queries that were assembled from text at the call site now live in `src/core/engine-sql/` and run through `BrainEngine` members (`listCorePageRows`, `listTrustScanRows`, `countUnscannedTrustRows`, `readBeliefHistoryRows`, `listVisibleBeliefLifetimes`, `pageAwaitsRederive`, `findPagesByTitles`, and three new `readWithdrawalDiscovery` kinds). Every value they carry is now a bound parameter, where before some were spliced into the text.
- The SQL text of those queries is different, but they return the same rows. Each one is checked against the old text on PGLite and Postgres, including a private page seen by a caller who may read only world pages. The visibility, quarantine and eligibility helpers are unchanged.
- The new members are held on the Rust engine as raw SQL until its store wiring lands, so they refuse there.
