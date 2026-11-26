**On a Rust-engine brain, memory_recall now answers for an ordinary member with `access.members_read_lineage` off.**

### Fixed
- The two reads memory_recall made with raw SQL, the written date of each fact (the UTC day, including years before 100) and the own-page flag of each fact, are now typed engine members, `readFactWrittenDates` and `readOwnMemberFactIds`, on all three engines. PGLite and Postgres send the same statements as before; the Rust engine answers them from its own store. forget_fact and the owner's default save ask the same own-page question and use the same member.

### Known gap
- `memory_recall` still refuses on a Rust-engine brain for a member when `access.members_read_lineage` is on (row 32e-b-4, due 2026-12-01) and for the brain owner (row RA-1, due 2026-11-28). Row 32e-b-7 of `docs/designs/RUST_ENGINE.md` tracks both as pinned stops and the verb as a swap blocker.
