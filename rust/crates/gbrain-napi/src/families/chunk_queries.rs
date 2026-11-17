//! Chunk reads the chunks capability still refuses. No methods yet.
//!
//! Store methods for: getChunkPage, getChunkWindows, countChunklessPagesWithContent,
//! listChunklessPagesWithContent.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::chunk_queries` module (see `pages.rs` in this
//! directory for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
