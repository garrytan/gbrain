**`gbrain agent register` now works on a Rust-engine brain.**

### Fixed
- `gbrain agent register` on a Rust-engine brain now registers the client, its grant and its first token. It used to write the client and then stop with "does not support executeRaw yet". Its source checks, name check and token step now go through typed engine members. PGLite and Postgres run the same checks as before. The per-name advisory lock is skipped on Rust, whose store already admits one write transaction at a time. Known gap: on Rust, `--preset coding-agent` for a name whose `<name>-workspace` source already exists still stops, because the check that the source is empty counts its pages, facts and files with raw SQL (`src/commands/agent-register.ts:632-644`); a new workspace source works.
