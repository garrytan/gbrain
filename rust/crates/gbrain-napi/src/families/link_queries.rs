//! Link and graph members the links and graph capabilities still refuse. No methods yet.
//!
//! Store methods for: replaceDerivedLinks, replaceDerivedLinksBatch, removeLinksByPagesAndSource,
//! listLinkSources, getBacklinkCounts, rewriteLinks, relationalFanout, relationalChainHop,
//! getAdjacencyBoosts, findOrphanPages.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::link_queries` module (see `pages.rs` in this
//! directory for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
