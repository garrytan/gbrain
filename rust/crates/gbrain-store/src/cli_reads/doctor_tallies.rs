//! Doctor tallies: counts `gbrain doctor` checks ran through `executeRaw` inside a catch that hid a capability refusal
//! (SQL in `src/core/engine-sql/doctor-tallies.ts`, docs in `rust/docs/store/cli-reads-doctor-tallies.md`). Each read
//! takes one snapshot and has no keys of its own; it reads page records, fact records and timeline records.

use std::collections::HashMap;

use crate::Store;
use crate::chunks::segmented;
use crate::error::{Result, StoreError};
use crate::facts::trust_reads::all_fact_rows;
use crate::keys;
use crate::kv::scan_prefix;
use crate::pages::all_pages;
use crate::timeline::TimelineRecord;

impl Store {
    /// `countLiveSegmentedPages({ projectionPending })`: live pages that keep their body in segments; with
    /// `projection_pending`, only those whose `text_projection_revision` is not their `knowledge_revision` (NULL counts:
    /// `IS DISTINCT FROM`).
    pub fn count_live_segmented_pages(&self, projection_pending: bool) -> Result<u64> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .iter()
            .filter(|p| p.deleted_at_us.is_none() && segmented(p))
            .filter(|p| {
                !projection_pending
                    || p.text_projection_revision.as_deref() != Some(p.knowledge_revision.as_str())
            })
            .count() as u64)
    }

    /// `countValidityLapsedFacts()`: facts with `valid_until <= now()` and no `expired_at`.
    pub fn count_validity_lapsed_facts(&self) -> Result<u64> {
        let read = self.read()?;
        let now = self.env.now_micros();
        Ok(all_fact_rows(&*read)?
            .iter()
            .filter(|f| {
                f.expired_at_us.is_none() && f.valid_until_us.is_some_and(|until| until <= now)
            })
            .count() as u64)
    }

    /// `countOrphanEventProjections(sourceIds)`: timeline rows whose event page exists and is soft-deleted, counted when
    /// that event page is in `source_ids` (`None`: every source). A row whose event page id names no page is not
    /// counted (the SQL's inner join).
    pub fn count_orphan_event_projections(&self, source_ids: Option<&[String]>) -> Result<u64> {
        let read = self.read()?;
        let pages: HashMap<u64, (bool, String)> = all_pages(&*read)?
            .into_iter()
            .map(|p| (p.id, (p.deleted_at_us.is_some(), p.source_id)))
            .collect();
        let mut n = 0u64;
        let mut failure = None;
        scan_prefix(&*read, &[keys::TIMELINE], false, &mut |_, v| {
            match serde_json::from_slice::<TimelineRecord>(v) {
                Ok(entry) => {
                    let orphan = entry
                        .event_page_id
                        .and_then(|id| pages.get(&id))
                        .is_some_and(|(deleted, source)| {
                            *deleted
                                && source_ids.is_none_or(|ids| ids.iter().any(|id| id == source))
                        });
                    if orphan {
                        n += 1;
                    }
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        failure.map_or(Ok(n), Err)
    }
}
