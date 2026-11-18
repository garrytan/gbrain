//! Group 5 facts reads of the stamped trust columns: `listSingleFactMetadata`
//! (src/core/engine-sql/facts-purge.ts) and `listUnpreviewedTrustFacts`
//! (src/core/engine-sql/facts-doctor.ts). Both read the `trust_tier` and `write_origin` the store
//! stamps on every fact row (`trust::stamp`); the second joins the released write-gate holds
//! (`trust/write_gate.rs`). Neither needs a key range of its own.
//!
//! The TypeScript member (src/core/rust-engine/store-members/facts-trust-reads.ts) refuses what the
//! store does not model: `listSingleFactMetadata` under the remote provenance floor, an id that is
//! not an `int4`, and a `listUnpreviewedTrustFacts` limit that is not a non-negative integer.

use super::{FactRecord, ROW, count_arg, read_fact, rows_under};
use crate::Store;
use crate::error::Result;
use crate::keys;
use crate::links::no_nul;
use crate::timeline_queries::jsonb_field_text;
use crate::trust::write_gate::released_fact_holds;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listSingleFactMetadata({ sourceId, ids, remoteFloor: false })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingleFactMetadataQuery {
    pub source_id: String,
    pub ids: Vec<i64>,
}

/// `listUnpreviewedTrustFacts(limit)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnpreviewedTrustQuery {
    pub limit: f64,
}

/// `write_origin->>'key'`: NULL for a row with no origin, an origin that is not an object, or a
/// key that is missing or JSON null.
fn origin_text(row: &FactRecord, key: &str) -> Option<String> {
    row.write_origin
        .as_ref()
        .and_then(|o| o.get(key))
        .and_then(jsonb_field_text)
}

/// Every fact row, in id order (`F 0x01 id` keys sort by id): the trust scan's fact rows
/// (`trust/tier_reads.rs`).
pub(crate) fn all_fact_rows(read: &dyn crate::kv::KvRead) -> Result<Vec<FactRecord>> {
    rows_under(read, &[keys::FACT, ROW])
}

impl Store {
    /// `listSingleFactMetadata`: the fence position, stored trust tier and claim slot of each fact
    /// of `sourceId` whose id is in `ids` (`id = ANY(ids)`: a repeated id answers once, an id no row
    /// has answers nothing). The SQL has no `ORDER BY`; the store answers in id order.
    pub fn list_single_fact_metadata(&self, q: &SingleFactMetadataQuery) -> Result<Vec<Value>> {
        no_nul("listSingleFactMetadata", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let wanted: BTreeSet<u64> = q
            .ids
            .iter()
            .filter_map(|&id| u64::try_from(id).ok())
            .collect();
        let mut out = Vec::with_capacity(wanted.len());
        for id in wanted {
            let Some(row) = read_fact(&*read, id)? else {
                continue;
            };
            if row.source_id != q.source_id {
                continue;
            }
            out.push(json!({
                "id": row.id,
                "source_markdown_slug": row.source_markdown_slug,
                "row_num": row.row_num,
                "trust_tier": row.tier().as_str(),
                "claim_metric": row.claim_metric,
                "claim_unit": row.claim_unit,
                "claim_period": row.claim_period,
            }));
        }
        Ok(out)
    }

    /// `listUnpreviewedTrustFacts(limit)`: every unexpired `user_confirmed` fact whose write origin
    /// names the `trust_release` channel and carries no `fields_previewed`, joined to the newest
    /// released fact hold of the same source, slug (`source_markdown_slug`), fence row
    /// (`payload->>'row_num' = row_num::text`) and request id (`IS NOT DISTINCT FROM`
    /// `write_origin->>'request_id'`). A fact with no such hold drops out. In id order, at most
    /// `limit`, each row with `total`, the count before the limit (`COUNT(*) OVER ()`).
    pub fn list_unpreviewed_trust_facts(&self, q: &UnpreviewedTrustQuery) -> Result<Vec<Value>> {
        let limit = count_arg("listUnpreviewedTrustFacts", "LIMIT", q.limit)?;
        let read = self.read()?;
        let holds = released_fact_holds(&*read)?;
        let mut facts: Vec<FactRecord> = rows_under(&*read, &[keys::FACT, ROW])?
            .into_iter()
            .filter(|f| {
                f.trust_tier == "user_confirmed"
                    && f.expired_at_us.is_none()
                    && origin_text(f, "channel").as_deref() == Some("trust_release")
                    && origin_text(f, "fields_previewed").is_none()
            })
            .collect();
        facts.sort_by_key(|f| f.id);
        let mut matched: Vec<(FactRecord, u64)> = Vec::new();
        for f in facts {
            let (Some(slug), Some(row_num)) = (f.source_markdown_slug.as_deref(), f.row_num) else {
                continue;
            };
            let row_text = row_num.to_string();
            let request = origin_text(&f, "request_id");
            let hold = holds
                .iter()
                .rev()
                .find(|h| {
                    h.source_id == f.source_id
                        && h.slug == slug
                        && h.row_num.as_deref() == Some(row_text.as_str())
                        && h.request_id == request
                })
                .map(|h| h.id);
            if let Some(hold_id) = hold {
                matched.push((f, hold_id));
            }
        }
        let total = matched.len();
        Ok(matched
            .into_iter()
            .take(limit)
            .map(|(f, hold_id)| {
                json!({
                    "id": f.id,
                    "source_id": f.source_id,
                    "slug": f.source_markdown_slug,
                    "row_num": f.row_num,
                    "hold_id": hold_id,
                    "total": total,
                })
            })
            .collect())
    }
}
