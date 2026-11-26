//! The `guest_sources` table of the SQL engines: which sources are guest sources, who may write them and the tier
//! ceiling their pages keep (src/core/guests/schema.ts), and the live notes in them
//! (src/core/engine-sql/collate-guest-sources.ts).
//!
//! Members: upsertGuestSource, listGuestNotes, and the row `readGuestSourceRow` (cli_reads/import.rs) reads.
//!
//! Keys (every record starts with `keys::GUEST_SOURCE`, `0`):
//! - `0 source_id` -> [`GuestRecord`] (JSON): the source's one row.
//!
//! A row needs its source (the table's foreign key) and a source with no local path (the guard trigger), and a source
//! delete removes it (`ON DELETE CASCADE`, `remove_source_rows`). The store holds the row and nothing reads it for
//! The trust stamp's guest-source rules read the row: [`guard_page`] (writer list and guest-note attribution, with
//! the ceiling the stamped tier is capped at, [`cap_at`]) and [`guard_row`] (no facts, takes or timeline entries).
//! The fail-closed refusal of a role that row-level security keeps from reading guest_sources
//! (`writer_coordinator_required`) cannot happen here: the store has no row-level security.
//! A source whose config says `guest` is not a row: only `upsertGuestSource` makes one. Reads that ask whether a
//! source is a guest source take either record ([`source_is_guest`], `guestSourceSql`); a source with a row takes
//! no local path ([`refuse_local_path_on_guest`]).

use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page;
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The tiers a `trust_ceiling` may name (`TRUST_TIERS`, src/core/trust/tier.ts; the table's CHECK).
const TIERS: [&str; 6] = [
    "user_confirmed",
    "operator_curated",
    "tool_observed",
    "agent_written",
    "unknown",
    "external_untrusted",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct GuestRecord {
    pub writers: Vec<String>,
    pub trust_ceiling: String,
}

fn row_key(source_id: &str) -> Vec<u8> {
    keys::text(keys::GUEST_SOURCE, &[source_id])
}

/// The row of `source_id`, if the source is a guest source by its row.
pub(crate) fn read_guest_row(read: &dyn KvRead, source_id: &str) -> Result<Option<GuestRecord>> {
    if source_id.contains('\0') {
        return Ok(None);
    }
    get_json(read, &row_key(source_id))
}

fn as_row(source_id: &str, row: &GuestRecord) -> Value {
    json!({ "source_id": source_id, "writers": row.writers, "trust_ceiling": row.trust_ceiling })
}

/// `guestSourceSql` (src/core/guests/note.ts): the source's config says guest, or it has a guest row. Either record
/// alone is enough, so a source that lost one of them still counts as a guest source.
pub(crate) fn source_is_guest(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    if read_source(read, source_id)?
        .is_some_and(|s| crate::cli_reads::import::config_says_guest(&s.config))
    {
        return Ok(true);
    }
    Ok(read_guest_row(read, source_id)?.is_some())
}

/// The guard trigger on `sources` (`gbrain_guard_guest_records`): a source with a guest row takes no local path.
pub(crate) fn refuse_local_path_on_guest(read: &dyn KvRead, source_id: &str) -> Result<()> {
    if read_guest_row(read, source_id)?.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "guest_source_database_only: a guest source is database-only and takes no local path or repository",
        ));
    }
    Ok(())
}

/// The store error code of a guest-source guard refusal on each table, `guest_source_guard:<table>`. The message
/// starts with the rule's code (`source_writer_restricted:`, `guest_attribution_missing:`, `guest_page_immutable:`),
/// as the trigger's does; rust-engine/store-errors.ts gives it the trigger's SQLSTATE, constraint and table.
pub const GUEST_SOURCE_GUARD_PAGES: &str = "guest_source_guard:pages";
pub const GUEST_SOURCE_GUARD_FACTS: &str = "guest_source_guard:facts";
pub const GUEST_SOURCE_GUARD_TAKES: &str = "guest_source_guard:takes";
pub const GUEST_SOURCE_GUARD_TIMELINE: &str = "guest_source_guard:timeline_entries";

fn refuse(table: &'static str, code: &str, message: &str) -> StoreError {
    StoreError::new(table, format!("{code}: {message}"))
}

/// The guarded row tables other than `pages`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GuardTable {
    Facts,
    Takes,
    TimelineEntries,
}

impl GuardTable {
    fn code(self) -> &'static str {
        match self {
            GuardTable::Facts => GUEST_SOURCE_GUARD_FACTS,
            GuardTable::Takes => GUEST_SOURCE_GUARD_TAKES,
            GuardTable::TimelineEntries => GUEST_SOURCE_GUARD_TIMELINE,
        }
    }
}

/// What a write did to a row of a guest-guarded table, as the trigger sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GuardOp {
    Insert,
    /// An UPDATE; `content_changed` compares the guarded content columns.
    Update {
        content_changed: bool,
    },
}

impl GuardOp {
    fn writes_content(self) -> bool {
        match self {
            GuardOp::Insert => true,
            GuardOp::Update { content_changed } => content_changed,
        }
    }
}

/// The guest-source rules of `gbrain_stamp_trust_tier` for a row of `pages` (src/core/trust/schema.ts `guestGuard`),
/// run before the stamp. A page in a guest source (its source has a guest row, or on a move the source it leaves has
/// one) may be inserted, or have a content column other than `deleted_at` changed (`op`), only by a principal on that
/// row's writer list (`source_writer_restricted`), and only as a guest note: `gbrain.guest_note` equal to
/// `gbrain.write_request` (`guest_attribution_missing`). Answers the ceiling the stamped tier is capped at: the
/// guest row of the page's new source, if any.
pub(crate) fn guard_page(
    read: &dyn KvRead,
    old_source: Option<&str>,
    new_source: &str,
    op: GuardOp,
    trust: &crate::trust::WriteTrust,
) -> Result<Option<crate::trust::TrustTier>> {
    let new_row = read_guest_row(read, new_source)?;
    let ceiling = new_row
        .as_ref()
        .map(|row| crate::trust::TrustTier::from_setting(Some(&row.trust_ceiling)))
        .transpose()?
        .flatten();
    let writers = match (&new_row, old_source) {
        (Some(row), _) => Some(row.writers.clone()),
        (None, Some(old)) if old != new_source => read_guest_row(read, old)?.map(|row| row.writers),
        _ => None,
    };
    let Some(writers) = writers else {
        return Ok(ceiling);
    };
    let attribution = &trust.attribution;
    let principal = match (&attribution.principal_kind, &attribution.principal_id) {
        (Some(kind), Some(id)) => Some(format!("{kind}:{id}")),
        _ => None,
    };
    if !principal.is_some_and(|p| writers.contains(&p)) {
        match op {
            GuardOp::Insert => {
                return Err(refuse(
                    GUEST_SOURCE_GUARD_PAGES,
                    "source_writer_restricted",
                    "only the listed writers of a guest source may create its pages",
                ));
            }
            GuardOp::Update {
                content_changed: true,
            } => {
                return Err(refuse(
                    GUEST_SOURCE_GUARD_PAGES,
                    "source_writer_restricted",
                    "only the listed writers of a guest source may change its pages",
                ));
            }
            GuardOp::Update {
                content_changed: false,
            } => {}
        }
    } else if op.writes_content() && !trust.guest_note_is_request {
        return Err(refuse(
            GUEST_SOURCE_GUARD_PAGES,
            "guest_attribution_missing",
            "a listed writer creates or changes a guest page only as a guest note",
        ));
    }
    Ok(ceiling)
}

/// The per-source ceiling on every exit of the trigger: a guest page is never stored above its source's ceiling.
pub(crate) fn cap_at(
    tier: crate::trust::TrustTier,
    ceiling: Option<crate::trust::TrustTier>,
) -> crate::trust::TrustTier {
    match ceiling {
        Some(ceiling) if tier.rank() > ceiling.rank() => ceiling,
        _ => tier,
    }
}

/// The guest-source rule for a row of `facts`, `takes` or `timeline_entries`: a guest source holds none, so an
/// insert or a content change of one in a guest source (by its guest row) is refused (`guest_page_immutable`).
/// Lifecycle updates and deletes pass. `source_id` is the fact's source, or the source of the take's or entry's page.
pub(crate) fn guard_row(
    read: &dyn KvRead,
    table: GuardTable,
    source_id: Option<&str>,
    op: GuardOp,
) -> Result<()> {
    if !op.writes_content() {
        return Ok(());
    }
    match source_id {
        Some(source) if read_guest_row(read, source)?.is_some() => Err(refuse(
            table.code(),
            "guest_page_immutable",
            "a guest source holds no facts, takes or timeline entries",
        )),
        _ => Ok(()),
    }
}

/// The source of page `page_id` (live or deleted), for the take and timeline rule.
pub(crate) fn page_source(read: &dyn KvRead, page_id: u64) -> Result<Option<String>> {
    Ok(crate::pages::read_page_by_id(read, page_id)?.map(|p| p.source_id))
}

/// The seed's copy of a primary's guest row (seed/privacy.rs): stored as given; false when the store already holds the
/// same row (a retried batch).
pub(crate) fn seed_row(
    tx: &mut dyn KvWrite,
    source_id: &str,
    writers: Vec<String>,
    trust_ceiling: String,
) -> Result<bool> {
    let row = GuestRecord {
        writers,
        trust_ceiling,
    };
    if read_guest_row(&*tx, source_id)?.is_some_and(|stored| {
        stored.writers == row.writers && stored.trust_ceiling == row.trust_ceiling
    }) {
        return Ok(false);
    }
    put_json(tx, &row_key(source_id), &row)?;
    Ok(true)
}

/// The shadow follower's removal of a guest row the primary deleted; false when the store holds none.
pub(crate) fn remove_row(tx: &mut dyn KvWrite, source_id: &str) -> Result<bool> {
    if read_guest_row(&*tx, source_id)?.is_none() {
        return Ok(false);
    }
    tx.delete(&row_key(source_id))?;
    Ok(true)
}

/// A source delete removes its guest row (the table's `ON DELETE CASCADE`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    tx.delete(&row_key(source_id))
}

impl Store {
    /// `upsertGuestSource(sourceId, writers, trustCeiling)`: writes the source's guest row, or merges `writers` into the
    /// row it has (distinct, in byte order; its ceiling stays), and answers the row. The source must exist and have no
    /// local path, and the ceiling must be a tier.
    pub fn upsert_guest_source(
        &self,
        source_id: &str,
        writers: &[String],
        trust_ceiling: &str,
    ) -> Result<Value> {
        let mut texts = vec![("sourceId", source_id), ("trustCeiling", trust_ceiling)];
        texts.extend(writers.iter().map(|w| ("writers", w.as_str())));
        no_nul("upsertGuestSource", &texts)?;
        self.write(|tx| {
            let Some(source) = read_source(tx, source_id)? else {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!(
                        "insert or update on table \"guest_sources\" violates foreign key constraint: source \"{source_id}\" does not exist"
                    ),
                ));
            };
            if source.local_path.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "guest_source_database_only: a source with a local path or repository cannot become a guest source",
                ));
            }
            if !TIERS.contains(&trust_ceiling) {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("new row for relation \"guest_sources\" violates check constraint: trust_ceiling \"{trust_ceiling}\""),
                ));
            }
            let row = match read_guest_row(tx, source_id)? {
                // The conflict branch: the union of the two lists, each once, by byte.
                Some(mut row) => {
                    let merged: BTreeSet<&String> = row.writers.iter().chain(writers).collect();
                    row.writers = merged.into_iter().cloned().collect();
                    row
                }
                None => GuestRecord {
                    writers: writers.to_vec(),
                    trust_ceiling: trust_ceiling.to_string(),
                },
            };
            put_json(tx, &row_key(source_id), &row)?;
            Ok(as_row(source_id, &row))
        })
    }

    /// `listGuestNotes(slug, guestSource?)`: `{ id, source_id }` of the live page at `slug` in each guest source (the
    /// ones with a row; only `guestSource` when given), by source id in byte order.
    pub fn list_guest_notes(&self, slug: &str, guest_source: Option<&str>) -> Result<Vec<Value>> {
        let mut texts = vec![("slug", slug)];
        texts.extend(guest_source.map(|s| ("guestSource", s)));
        no_nul("listGuestNotes", &texts)?;
        let read = self.read()?;
        let mut sources = Vec::new();
        scan_prefix(&*read, &[keys::GUEST_SOURCE], false, &mut |k, _| {
            sources.push(String::from_utf8_lossy(&k[1..]).into_owned());
            true
        })?;
        let mut out = Vec::new();
        for source in sources
            .iter()
            .filter(|s| guest_source.is_none_or(|g| g == s.as_str()))
        {
            if let Some(page) =
                read_page(&*read, source, slug)?.filter(|p| p.deleted_at_us.is_none())
            {
                out.push(json!({ "id": page.id, "source_id": source }));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_source_rows_drops_only_that_sources_row() {
        let store = crate::test_support::store();
        for id in ["one", "two"] {
            store
                .upsert_source(&crate::sources::SourceInput {
                    id: id.into(),
                    ..Default::default()
                })
                .unwrap();
            store
                .upsert_guest_source(id, &["w".into()], "unknown")
                .unwrap();
        }
        store.write(|tx| remove_source_rows(tx, "one")).unwrap();
        let read = store.read().unwrap();
        assert!(read_guest_row(&*read, "one").unwrap().is_none());
        assert!(read_guest_row(&*read, "two").unwrap().is_some());
    }
}
