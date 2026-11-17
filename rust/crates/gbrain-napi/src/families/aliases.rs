//! Slug renames and page aliases. No methods yet.
//!
//! Store methods for: updateSlug, resolveSlugWithAlias, resolveSlugWithAliasDetailed,
//! resolveAliases, setPageAliases, updatePageContextualRetrievalState.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::aliases` module (see `pages.rs` in this directory
//! for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
