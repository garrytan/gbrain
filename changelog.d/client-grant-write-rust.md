**`gbrain agent register` now works on a Rust-engine brain.**

### Fixed
- `gbrain agent register` on a Rust-engine brain now registers the client, its grant and its first token. It used to write the client and then stop with "does not support executeRaw yet". Its source checks, name check and token step now go through typed engine members. PGLite and Postgres run the same checks as before. The per-name advisory lock is skipped on Rust, whose store already admits one write transaction at a time. Registering with a workspace source that already exists still stops by name on Rust.
