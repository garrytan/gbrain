//! Facts and their supersession chains. Nothing is built yet: every member below still refuses with
//! `engine_capability_missing` in the TypeScript engine.
//!
//! Members: insertFact, insertFacts, deleteFactsForPage, expireFact, listFactsByEntity,
//! listFactsSince, listFactsKeyset, listFactsBySession, listSupersessions,
//! countUnconsolidatedFacts, findCandidateDuplicates, consolidateFact, findTrajectory,
//! getFactsHealth, migrateFactsToCanonical, and the `pageCollapseFacts` search read
//! (`facts/collapse.rs`).
//!
//! Keys: every record of this family starts with `keys::FACT` (`F`). The bytes after the tag are
//! this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.

mod collapse;
mod embedding;

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

// ---------------------------------------------------------------------------------------------
// Postgres text functions the members use.

/// Code points Postgres `lower()` leaves alone that Rust's `char::to_lowercase` maps (the two
/// Unicode tables differ). Probed on PGLite.
const LOWER_KEEP: [(u32, u32); 41] = [
    (0x1C89, 0x1C89),
    (0x24B6, 0x24CF),
    (0x2C2F, 0x2C2F),
    (0xA7C0, 0xA7C0),
    (0xA7C7, 0xA7C7),
    (0xA7C9, 0xA7C9),
    (0xA7CB, 0xA7CC),
    (0xA7CE, 0xA7CE),
    (0xA7D0, 0xA7D0),
    (0xA7D2, 0xA7D2),
    (0xA7D4, 0xA7D4),
    (0xA7D6, 0xA7D6),
    (0xA7D8, 0xA7D8),
    (0xA7DA, 0xA7DA),
    (0xA7DC, 0xA7DD),
    (0xA7E2, 0xA7E2),
    (0xA7F5, 0xA7F5),
    (0xAB6C, 0xAB6D),
    (0x10570, 0x1057A),
    (0x1057C, 0x1058A),
    (0x1058C, 0x10592),
    (0x10594, 0x10595),
    (0x10D50, 0x10D65),
    (0x16EA0, 0x16EB8),
    (0x1DF40, 0x1DF40),
    (0x1DF48, 0x1DF48),
    (0x1DF4A, 0x1DF4A),
    (0x1DF4D, 0x1DF4D),
    (0x1DF51, 0x1DF51),
    (0x1DF68, 0x1DF68),
    (0x1DF6A, 0x1DF6A),
    (0x1DF6C, 0x1DF6C),
    (0x1DF6E, 0x1DF6E),
    (0x1DF72, 0x1DF72),
    (0x1DF74, 0x1DF74),
    (0x1DF76, 0x1DF76),
    (0x1DF78, 0x1DF78),
    (0x1DF7A, 0x1DF7A),
    (0x1DF7C, 0x1DF7C),
    (0x1DF7E, 0x1DF7E),
    (0xFEFF, 0xFEFF),
];

/// Postgres `lower()` of one code point: one code point out, the first of the full mapping
/// ('İ' gives 'i').
pub(crate) fn pg_lower_char(c: char) -> char {
    let cp = c as u32;
    if LOWER_KEEP.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp)) {
        return c;
    }
    c.to_lowercase().next().unwrap_or(c)
}
