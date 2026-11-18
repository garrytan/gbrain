//! Code call edges between chunks and symbols. No methods yet.
//!
//! Store methods for: addCodeEdges, deleteCodeEdgesForChunks, getCallersOf, getCalleesOf,
//! getEdgesByChunk.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::code_edges` module (see `pages.rs` in this
//! directory for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
