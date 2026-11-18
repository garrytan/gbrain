//! Link and graph members the links and graph capabilities still refuse. Nothing is built yet:
//! every member below still refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: replaceDerivedLinks, replaceDerivedLinksBatch, removeLinksByPagesAndSource,
//! listLinkSources, getBacklinkCounts, rewriteLinks, relationalFanout, relationalChainHop,
//! getAdjacencyBoosts, findOrphanPages.
//!
//! Keys: every record of this family starts with `keys::LINK_QUERIES` (`q`). The bytes after the
//! tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
