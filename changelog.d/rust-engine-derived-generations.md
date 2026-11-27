**A facts or takes fence write now runs to the end on a Rust brain, and a held fence result shows up there as it does on Postgres.**

### Changed
- The generation records behind every fence write (read the live generation, activate the next one, record a held result) are now engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain stores those records itself. A fence write there publishes generation 1, then 2, and a result that may not publish is held. `gbrain get`, doctor and `gbrain sync status` list it, and a readable fence clears it. Before, the write stopped at the first generation read, and a Rust brain never showed a held result.
- The other generation work (the attempt counter, the repeat check, the retirement valve, restores and repairs) still runs raw SQL, so it still stops on a Rust brain.

