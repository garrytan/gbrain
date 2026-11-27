**On the Rust engine, `gbrain auth list` shows where a read-shared key writes and what it reads.**

### Fixed
- On a brain with the Rust engine, `gbrain auth list` left out the line `write: <source>  reads: ... (+ shared)` under a key with the read-shared switch on, because the Rust token list did not return the key's source grant. The list now returns it, and the output matches PGLite and Postgres. `gbrain auth list --json` was not affected. Nothing to do on upgrade.
