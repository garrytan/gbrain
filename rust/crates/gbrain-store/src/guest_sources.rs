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
//! write admission: it has no trust trigger, so the writers and the ceiling are kept for the members that read them.
//! A source whose config says `guest` is not a row: only `upsertGuestSource` makes one.

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
