//! Facts and their supersession chains. Nothing is built yet: every member below still refuses with
//! `engine_capability_missing` in the TypeScript engine.
//!
//! Members: insertFact, insertFacts, deleteFactsForPage, expireFact, listFactsByEntity,
//! listFactsSince, listFactsKeyset, listFactsBySession, listSupersessions,
//! countUnconsolidatedFacts, findCandidateDuplicates, consolidateFact, findTrajectory,
//! getFactsHealth, migrateFactsToCanonical.
//!
//! Keys: every record of this family starts with `keys::FACT` (`F`). The bytes after the tag are
//! this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.

/// Deletes this family's records keyed by a source that is deleted (`cascade::remove_source_rows`).
/// Nothing to delete yet. Full paths keep this stub clear of the imports this file will add.
pub(crate) fn remove_source_rows(
    _tx: &mut dyn crate::kv::KvWrite,
    _source_id: &str,
) -> crate::Result<()> {
    Ok(())
}

/// Moves this family's records keyed by `(source, slug)` from `old_slug` to `new_slug` when a page
/// is renamed (`cascade::rename_slug_rows`, PGLite `moveSlugBindings`): fact withdrawals by
/// `subject`, facts by `entity_slug` and by `source_markdown_slug`, dropping the rows the new slug
/// already holds as PGLite does. Nothing to move yet.
pub(crate) fn rename_slug_rows(
    _tx: &mut dyn crate::kv::KvWrite,
    _source_id: &str,
    _old_slug: &str,
    _new_slug: &str,
) -> crate::Result<()> {
    Ok(())
}
