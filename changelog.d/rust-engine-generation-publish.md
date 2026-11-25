**A derived generation publishes to the end on a Rust brain, with its repeat check, failure counter and retirement valve.**

### Changed
- The rest of a generation publish (the check for an identical repeat, the count of failed attempts, the held result after three failures, the "already held for this input" check and the retirement valve) now uses engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain stores the failure counters and the valve windows itself. A publish there runs to the end: a repeat answers "unchanged", too many retirements in one run hold the result, and three failures of one result hold it with their error codes. Before, every such publish stopped at its first generation read.
- Restores, repairs, fence evidence, the ledger scrub and managed publication still use raw SQL, so they still stop on a Rust brain.
