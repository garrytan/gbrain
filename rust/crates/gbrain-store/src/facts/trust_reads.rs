//! Group 5 facts reads of the stamped trust columns: `listSingleFactMetadata`
//! (src/core/engine-sql/facts-purge.ts), `listUnpreviewedTrustFacts`
//! (src/core/engine-sql/facts-doctor.ts) and `listRestatedPrivateCopies`
//! (src/core/engine-sql/facts-trust.ts, the write-time supersede check). Both read the `trust_tier` and `write_origin` the store
//! stamps on every fact row (`trust::stamp`); the second joins the released write-gate holds
//! (`trust/write_gate.rs`). Neither needs a key range of its own.
//!
//! The TypeScript member (src/core/rust-engine/store-members/facts-trust-reads.ts) refuses what the
//! store does not model: an id that is not an `int4`, a `listUnpreviewedTrustFacts` limit that is
//! not a non-negative integer, and the remote provenance floor of a caller whose labelled-only grant
//! or owner read changes it (`storeFloorPolicy`).

use super::privacy::PrivacyPolicy;
use super::{
    FactRecord, OwnerOnlyCache, ROW, count_arg, entity_rows, hidden_by_policy, read_fact,
    rows_under, source_rows,
};
use crate::Store;
use crate::error::Result;
use crate::keys;
use crate::links::no_nul;
use crate::timeline_queries::jsonb_field_text;
use crate::trust::TrustTier;
use crate::trust::write_gate::released_fact_holds;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listSingleFactMetadata({ sourceId, ids, remoteFloor })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingleFactMetadataQuery {
    pub source_id: String,
    pub ids: Vec<i64>,
    /// `remoteProvenanceFloorSql('facts')` when the caller passes `remoteFloor`.
    #[serde(default)]
    pub remote_floor: Option<PrivacyPolicy>,
}

/// `listRestatedPrivateCopies({ sourceId, claim, entity, writer })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestatedPrivateCopiesQuery {
    pub source_id: String,
    pub claim: String,
    pub entity: Option<String>,
    pub writer: String,
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
    /// has answers nothing), less a fact the remote provenance floor hides. The SQL has no
    /// `ORDER BY`; the store answers in id order.
    pub fn list_single_fact_metadata(&self, q: &SingleFactMetadataQuery) -> Result<Vec<Value>> {
        no_nul("listSingleFactMetadata", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let wanted: BTreeSet<u64> = q
            .ids
            .iter()
            .filter_map(|&id| u64::try_from(id).ok())
            .collect();
        let mut out = Vec::with_capacity(wanted.len());
        let mut owner_only = OwnerOnlyCache::default();
        for id in wanted {
            let Some(row) = read_fact(&*read, id)? else {
                continue;
            };
            if row.source_id != q.source_id
                || hidden_by_policy(&*read, &row, &q.remote_floor, &mut owner_only)?
            {
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

    /// `listRestatedPrivateCopies`: the active non-world fact of `sourceId` stating exactly `claim`
    /// on `entity` (`IS NOT DISTINCT FROM`: no entity matches a row with none), more trusted than
    /// `writer` (`trustRankSql(trust_tier) > TRUST_TIER_RANK[writer] ?? 0`; a writer name that is no
    /// tier ranks 0), while no active `world` fact on that entity states
    /// it. Active: `expired_at IS NULL` and `valid_until` null or after now. The lowest id, at most one.
    pub fn list_restated_private_copies(
        &self,
        q: &RestatedPrivateCopiesQuery,
    ) -> Result<Vec<Value>> {
        let mut checked = vec![
            ("sourceId", q.source_id.as_str()),
            ("claim", q.claim.as_str()),
            ("writer", q.writer.as_str()),
        ];
        if let Some(entity) = q.entity.as_deref() {
            checked.push(("entity", entity));
        }
        no_nul("listRestatedPrivateCopies", &checked)?;
        let now = self.env.now_micros();
        let writer = TrustTier::parse(&q.writer).map_or(0, TrustTier::rank);
        let read = self.read()?;
        let rows = match q.entity.as_deref() {
            Some(entity) => entity_rows(&*read, &q.source_id, entity)?,
            None => source_rows(&*read, &q.source_id)?,
        };
        let active = |f: &FactRecord| {
            f.fact == q.claim
                && f.entity_slug == q.entity
                && f.expired_at_us.is_none()
                && f.valid_until_us.is_none_or(|until| until > now)
        };
        let mut matched: Vec<&FactRecord> = rows.iter().filter(|f| active(f)).collect();
        if matched.iter().any(|f| f.visibility == "world") {
            return Ok(Vec::new());
        }
        matched.retain(|f| f.tier().rank() > writer);
        Ok(matched
            .into_iter()
            .min_by_key(|f| f.id)
            .map(|f| json!({ "id": f.id, "visibility": f.visibility, "trust_tier": f.tier().as_str() }))
            .into_iter()
            .collect())
    }
}
