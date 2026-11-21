**The experimental Rust engine now records the embedding model a new brain is created with, and `gbrain files list`, `gbrain auth list` and the source check of a remote recall now work on it.**

### Fixed
- A new Rust-engine brain now writes the `embedding_model`, `embedding_dimensions` and `chunk_strategy` settings that PGLite and Postgres write at creation, taken from the same configuration. Before, a chunk saved with no model of its own came back as `unconfigured` on the Rust engine.
- `gbrain files list` now works on the Rust engine. Before, it stopped with a raw SQL refusal. It lists the same files in the same order on every engine.
- `gbrain auth list` now works on the Rust engine. It lists no tokens there, because the Rust engine does not keep access tokens yet.
- A remote `memory_recall` on the Rust engine no longer stops at the check that drops sources marked as scope sources. The check now reads each source through the engine.
