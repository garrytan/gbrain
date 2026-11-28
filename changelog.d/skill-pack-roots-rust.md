**On a Rust-engine brain, an adopted skill pack now protects its files and its ghost pages as it does on PGLite and Postgres.**

### Fixed
- A Rust brain answered that no shared skill pack existed, so a knowledge write to a pack's reserved path (`skills/...`, `skillpack.json`) was allowed instead of refused with `skill_bundle_required`, and the ghost-page scan behind doctor `ghost_pages` and `gbrain repair ghost-pages` failed because it read the pack through raw SQL. The pack roots, the pack membership check and the page file reads are now typed engine reads that every engine serves, so both give the same answer on every engine.
