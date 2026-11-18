//! Raw source data and files attached to pages. No methods yet.
//!
//! Store methods for: putRawData, getRawData, upsertFile, getFile, listFilesForPage.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::raw_files` module (see `pages.rs` in this
//! directory for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
