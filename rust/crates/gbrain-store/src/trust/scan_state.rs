//! The trust scan's two state reads besides its cursor: `listClaimPendingSourceIds` and
//! `readTrustScanCeilings` of `src/core/engine-sql/trust-scan.ts` (rust/docs/store/trust.md,
//! "Trust scan state"). The cursor is `persistence/trust_scan_cursor.rs`.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::{Result, StoreError};
use crate::facts::trust_reads::all_fact_rows;
use crate::keys;
use crate::kv::scan_prefix;
use crate::pages::all_pages;
use crate::sources::all_sources;
use crate::takes::all_takes;
use crate::timeline::TimelineRecord;
use serde::Deserialize;
use serde_json::{Value, json};

/// `listClaimPendingSourceIds`' input: the connector source kinds `claimPendingSql` excludes
/// (`CONNECTOR_SOURCE_KINDS`, sent by the TypeScript member so the list stays in one place).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPendingQuery {
    pub connector_kinds: Vec<String>,
}

fn max_timeline_id(read: &dyn crate::kv::KvRead) -> Result<u64> {
    let mut max = 0;
    let mut failure = None;
    scan_prefix(read, &[keys::TIMELINE], false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => max = max.max(entry.id),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(max), Err)
}

impl Store {
    /// `listClaimPendingSourceIds()`: the sources `claimPendingSql` matches, by id in byte order.
    /// A source matches when its config has the key `trust_claimed_at` (any value),
    /// `trust_tier` reads `operator_curated` as `->>` text, `kind` (`''` when absent) is not a
    /// connector kind, and it has no `trust_claim_lifted_at` key. Archived sources count, as
    /// the SQL does not filter them.
    pub fn list_claim_pending_source_ids(&self, q: &ClaimPendingQuery) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut ids: Vec<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| {
                let c = &s.config;
                c.contains_key("trust_claimed_at")
                    && fm_text(c, "trust_tier").as_deref() == Some("operator_curated")
                    && !q
                        .connector_kinds
                        .contains(&fm_text(c, "kind").unwrap_or_default())
                    && !c.contains_key("trust_claim_lifted_at")
            })
            .map(|s| s.id)
            .collect();
        ids.sort();
        Ok(ids)
    }

    /// `readTrustScanCeilings()`: `{ pages, facts, takes, timeline_entries }`, each table's max
    /// id over every stored row (soft-deleted pages included, as `max(id)` reads them), 0 when
    /// the table is empty.
    pub fn read_trust_scan_ceilings(&self) -> Result<Value> {
        let read = self.read()?;
        let pages = all_pages(&*read)?.iter().map(|p| p.id).max().unwrap_or(0);
        let facts = all_fact_rows(&*read)?
            .iter()
            .map(|f| f.id)
            .max()
            .unwrap_or(0);
        let takes = all_takes(&*read)?.iter().map(|t| t.id).max().unwrap_or(0);
        let timeline = max_timeline_id(&*read)?;
        Ok(json!({ "pages": pages, "facts": facts, "takes": takes, "timeline_entries": timeline }))
    }
}
