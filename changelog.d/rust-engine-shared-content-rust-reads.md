**On the experimental Rust engine, `gbrain apply-migrations` and `gbrain upgrade` now exit 0 on a brain swapped from PGLite, because the v0.53.0 shared-content migration that every upgrade reruns no longer reads raw SQL there; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Fixed
- On a Rust brain, the v0.53.0 shared-content migration reads its source list through the engine's own source reads, and the sealed skill pack and its heads through the Rust store, instead of SQL the Rust engine refuses. It now prints the same per-source result as on the PGLite brain the Rust brain came from.
