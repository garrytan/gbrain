//! Persistence: the tables the TypeScript persistence coordinator reads and writes (write requests,
//! effects, capacity counters, operation checkpoints, worktree bindings, consumers and the page
//! projection queue). The coordinator stays TypeScript; this family stores its rows. Nothing is
//! built yet beyond `journal.rs`: TypeScript reaches these tables through `executeRaw`, which the
//! Rust engine refuses.
//!
//! Keys: write requests stay under `keys::REQUEST` and `keys::REQUEST_ID` and local writers under
//! `keys::WRITER` (`journal.rs`). Every other record of this family starts with
//! `keys::PERSISTENCE` (`d`). The bytes after the tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md ("persistence (core)").

/// Keeps the page projection queue in step with a page write (`page_projection::
/// queue_page_projection`). Queues nothing yet. Full paths keep this stub clear of the imports
/// this file will add.
pub(crate) fn queue_page_projection(
    _tx: &mut dyn crate::kv::KvWrite,
    _before: Option<&crate::pages::PageRecord>,
    _after: Option<&crate::pages::PageRecord>,
) -> crate::Result<()> {
    Ok(())
}
