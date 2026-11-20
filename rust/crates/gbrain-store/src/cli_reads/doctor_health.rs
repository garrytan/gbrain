//! Doctor reads, health set: the typed members that replace the raw SQL of the calibration and
//! remote-report checks (SQL in `src/core/engine-sql/doctor-health.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-health.md`). Each read takes one snapshot and has no keys of
//! its own. The catalog members of the same file are answered by the TypeScript engine layer from
//! the key layout, and the request-index read refuses; see the doc.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::Store;
use crate::aliases::read_cr;
use crate::chunks::SAFE_FENCE_CHUNKER_VERSION;
use crate::env::{civil_from_days, days_from_civil, days_in_month};
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::scan_prefix;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::takes::all_takes;
use crate::timeline::TimelineRecord;

const DAY_US: i64 = 86_400_000_000;

fn in_scope(sources: Option<&[String]>, source_id: &str) -> bool {
    sources.is_none_or(|s| s.iter().any(|x| x == source_id))
}

/// `(text)::date` for the `YYYY-MM-DD` text the abandoned-threads cast builds: days since the
/// epoch, or the error Postgres raises for the same text.
fn pg_date_days(text: &str) -> Result<i64> {
    let syntax = || StoreError::invalid(format!("invalid input syntax for type date: \"{text}\""));
    let parts: Vec<&str> = text.split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        return Err(syntax());
    };
    let num = |s: &str| -> Result<i64> {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            return Err(syntax());
        }
        s.parse::<i64>().map_err(|_| syntax())
    };
    let (y, m, d) = (num(y)?, num(m)?, num(d)?);
    let range = || StoreError::invalid(format!("date/time field value out of range: \"{text}\""));
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m).ok_or_else(range)? {
        return Err(range());
    }
    Ok(days_from_civil(y, m, d))
}

/// `now() - INTERVAL '12 months'` in microseconds (UTC, as PGLite runs in `Etc/GMT0`): the same
/// time of day, a year earlier, with the day clamped to the end of that month.
fn twelve_months_before(now_us: i64) -> i64 {
    let days = now_us.div_euclid(DAY_US);
    let time_of_day = now_us.rem_euclid(DAY_US);
    let (y, m, d) = civil_from_days(days);
    let d = d.min(days_in_month(y - 1, m).unwrap_or(28));
    days_from_civil(y - 1, m, d) * DAY_US + time_of_day
}

impl Store {
    /// `countContextualRetrievalCoverage(markdownChunkerVersion, sourceIds?)`: live pages chunked
    /// below the markdown chunker version (markdown), below the safe-chunk fence (every kind, and
    /// code alone), and markdown pages with no contextual-retrieval stamp (extract receipts aside).
    /// A record with no chunker version is below both (PGLite's column default is 1).
    pub fn count_contextual_retrieval_coverage(
        &self,
        markdown_chunker_version: i64,
        source_ids: Option<&[String]>,
    ) -> Result<Value> {
        let read = self.read()?;
        let (mut drift, mut unsealed, mut unsealed_code, mut mode_null) = (0u64, 0u64, 0u64, 0u64);
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !in_scope(source_ids, &page.source_id) {
                continue;
            }
            let version = page.chunker_version.unwrap_or(0);
            let markdown = page.page_kind == "markdown";
            if markdown && i64::from(version) < markdown_chunker_version {
                drift += 1;
            }
            if version < SAFE_FENCE_CHUNKER_VERSION {
                unsealed += 1;
                if page.page_kind == "code" {
                    unsealed_code += 1;
                }
            }
            if markdown
                && page.page_type != "extract_receipt"
                && read_cr(&*read, page.id)?.is_none()
            {
                mode_null += 1;
            }
        }
        Ok(json!({
            "chunker_drift": drift,
            "unsealed": unsealed,
            "unsealed_code": unsealed_code,
            "mode_null": mode_null,
        }))
    }

    /// `countAbandonedThreads(sourceIds?)`: active, unresolved, unsuperseded takes of weight 0.7 or
    /// more whose `since_date` (a `YYYY-MM` month read as its 1st) is more than 12 months ago. The
    /// weight compares as Postgres compares `real >= 0.7`: the stored single-precision value widened
    /// to double, so a weight stored as 0.7 is below it. `sourceIds` keeps takes on pages of those
    /// sources, deleted pages included.
    pub fn count_abandoned_threads(&self, source_ids: Option<&[String]>) -> Result<u64> {
        let read = self.read()?;
        let cutoff = twelve_months_before(self.env.now_micros());
        let mut page_sources: HashMap<u64, Option<String>> = HashMap::new();
        let mut count = 0u64;
        for take in all_takes(&*read)? {
            if !take.active
                || take.resolved_at_us.is_some()
                || take.superseded_by.is_some()
                || f64::from(take.weight) < 0.7
            {
                continue;
            }
            let Some(since) = take.since_date.as_deref() else {
                continue;
            };
            let text = if since.chars().count() == 7 {
                format!("{since}-01")
            } else {
                since.to_owned()
            };
            if pg_date_days(&text)? * DAY_US >= cutoff {
                continue;
            }
            if let Some(scope) = source_ids {
                let source = match page_sources.get(&take.page_id) {
                    Some(source) => source.clone(),
                    None => {
                        let source = read_page_by_id(&*read, take.page_id)?.map(|p| p.source_id);
                        page_sources.insert(take.page_id, source.clone());
                        source
                    }
                };
                if !source.is_some_and(|s| scope.contains(&s)) {
                    continue;
                }
            }
            count += 1;
        }
        Ok(count)
    }

    /// `countOrphanedEventProjections(sourceIds?)`: timeline rows that project an event page which
    /// is soft-deleted; `sourceIds` keeps those whose event page is in those sources.
    pub fn count_orphaned_event_projections(&self, source_ids: Option<&[String]>) -> Result<u64> {
        let read = self.read()?;
        let mut events: HashMap<u64, Option<PageRecord>> = HashMap::new();
        let mut projected: Vec<u64> = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::TIMELINE], false, &mut |_, v| {
            match serde_json::from_slice::<TimelineRecord>(v) {
                Ok(entry) => projected.extend(entry.event_page_id),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut count = 0u64;
        for event_id in projected {
            let event = match events.entry(event_id) {
                std::collections::hash_map::Entry::Occupied(found) => found.into_mut(),
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(read_page_by_id(&*read, event_id)?)
                }
            };
            if let Some(page) = event
                && page.deleted_at_us.is_some()
                && in_scope(source_ids, &page.source_id)
            {
                count += 1;
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_parses_as_postgres_casts_it() {
        assert_eq!(pg_date_days("1970-01-02").unwrap(), 1);
        assert_eq!(
            pg_date_days("2024-02-29").unwrap(),
            days_from_civil(2024, 2, 29)
        );
        assert!(
            pg_date_days("2025-13-01")
                .unwrap_err()
                .to_string()
                .contains("out of range")
        );
        assert!(
            pg_date_days("2025-02-30")
                .unwrap_err()
                .to_string()
                .contains("out of range")
        );
        assert!(
            pg_date_days("soon")
                .unwrap_err()
                .to_string()
                .contains("invalid input syntax for type date")
        );
    }

    #[test]
    fn twelve_months_back_keeps_the_time_and_clamps_the_day() {
        let leap = days_from_civil(2024, 2, 29) * DAY_US + 3_600_000_000;
        assert_eq!(
            twelve_months_before(leap),
            days_from_civil(2023, 2, 28) * DAY_US + 3_600_000_000
        );
        let plain = days_from_civil(2026, 11, 20) * DAY_US;
        assert_eq!(
            twelve_months_before(plain),
            days_from_civil(2025, 11, 20) * DAY_US
        );
    }
}
