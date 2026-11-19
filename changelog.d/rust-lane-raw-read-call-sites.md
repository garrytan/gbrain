**On a Rust brain, op resume, the health memo and the synopsis-tier check no longer stop on a raw read.**

### Fixed
- On a Rust brain, three reads ran through raw SQL, which the Rust engine refuses. Each caller caught the refusal, so the answer looked right, but it took a fallback every time. The reads are now typed engine members with the same SQL on Postgres and PGLite:
  - A resumable op's checkpoint load no longer logs a failed read. A Rust brain keeps no op checkpoint, so the op walks from the start, as before.
  - `get_health` reuses a fresh answer again. Before, the memo's clock read failed and every call recomputed. A Rust brain's clock is its commit sequence, so any write ends the reuse.
  - The synopsis-tier check answers. Before, it stopped. A Rust brain keeps no source synopsis mode, so no source selects that tier.
