**On the experimental Rust engine, `gbrain sources writer deactivate` and `gbrain sources writer activate` now work after a writer claim, so a claimed source no longer blocks sync for good.**

### Changed
- The release and activation steps moved from raw SQL into two typed engine members. PGLite and Postgres run the same SQL as before.
- The Rust store now keeps the brain's managed mode and its epoch, so a Rust brain reports `enabled: true` after an activation instead of always reporting a classic brain.
- On the Rust engine, managed writes still refuse after an activation; a managed deactivate returns the brain to classic sync.
