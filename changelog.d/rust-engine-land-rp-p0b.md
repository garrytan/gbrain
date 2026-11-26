**Persistence, trust, belief and purge reads and writes go through named engine members instead of raw SQL, and nothing you run changes.**

### Changed
- About 115 more `BrainEngine` members now carry statements that the write journal, writer administration, belief ledger, trust and withdrawal ledgers, purge planning and verification, chunk and link reads and the doctor checks ran inline through `executeRaw`. PGLite and Postgres run the same SQL as before; a Rust-backed brain refuses a member it cannot serve yet with a typed capability error.
- A cancelled request still sends no statement from these members, as `executeRaw` refused it: each member that moved off `executeRaw` checks the request before every statement.
- Result labels for facts and pages keep their source-precedence class when read through the typed trust members.
- The Rust shadow evidence epoch restarts when this ships (adapter version 8 to 9). No migration.
