//! Keyword search members the keyword_search capability still refuses, and title trigrams. No
//! methods yet.
//!
//! Store methods for: countKeywordPages, searchKeywordPages, searchTitles, searchKeywordChunks,
//! findByTitleFuzzy.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::keyword` module (see `pages.rs` in this directory
//! for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
