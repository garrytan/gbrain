//! Group 5 facts reads, purge, withdrawal, relink and fence repair (src/core/engine-sql/facts-purge.ts).
//!
//! Eleven of the thirteen members are served here from the fact rows and the pages.
//! `listFactsReconcileBacklog` is served from the `page_facts_reconcile` watermark in
//! `facts/reconcile.rs`, and `listSingleFactMetadata` from `facts/trust_reads.rs`
//! (rust/docs/store/facts.md).
//!
//! Text comparisons are byte comparisons, as Postgres's deterministic collation makes them, and a
//! NULL entity or slug never equals anything (`entity_slug = $4` is NULL for a row with no entity).
//!
//! Shared rules, read from the SQL:
//!
//! - An outcome marker is a row whose `source` is a checkpoint source and whose `fact` is
//!   `EXTRACTION_COMPLETE` or `EXTRACTION_NOT_APPLICABLE` (`outcomeMarkerSql`).
//! - An unbacked entity is a name key: it has a value, no `/`, and no live page of the source holds
//!   it as a slug (`unbackedEntitySql`; an empty name has no `/`, so it is unbacked).
//! - A fingerprint match compares `gbrain_fact_fingerprint(fact)`.

use super::embedding::{cosine_distance, float4_out};
use super::privacy::PrivacyPolicy;
use super::{
    AUDIT_ROW_SOURCES, FactRecord, ROW, bigint, count_arg, fact_by_number, fact_fingerprint,
    hidden_by_policy, invalid, opt_time, page_rows, real, rows_under, source_rows, write_fact,
};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::keys;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::trust::withdrawals::withdrawals_of;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `OUTCOME_MARKER_FACTS` (src/core/facts/audit-sources.ts).
const OUTCOME_MARKER_FACTS: [&str; 2] = ["EXTRACTION_COMPLETE", "EXTRACTION_NOT_APPLICABLE"];
/// `ownedMemorySubjectSql`: the member page prefix and the scope page.
const MEMBER_PAGE_PREFIX: &str = "memory/members/";
const SCOPE_PAGE_SLUG: &str = "memory/scope";

/// `outcomeMarkerSql`.
fn outcome_marker(row: &FactRecord) -> bool {
    AUDIT_ROW_SOURCES.contains(&row.source.as_str())
        && OUTCOME_MARKER_FACTS.contains(&row.fact.as_str())
}

/// `unbackedEntitySql`: `COALESCE(strpos(entity_slug, '/') = 0 AND NOT EXISTS (live page), false)`.
pub(super) fn unbacked(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let Some(entity) = row.entity_slug.as_deref() else {
        return Ok(false);
    };
    if entity.contains('/') {
        return Ok(false);
    }
    Ok(!read_page(read, &row.source_id, entity)?.is_some_and(|p| p.deleted_at_us.is_none()))
}

/// `ownedMemorySubjectSql`: the subject names a member page or the scope page.
fn owned_memory_subject(subject: &str) -> bool {
    subject.starts_with(MEMBER_PAGE_PREFIX) || subject == SCOPE_PAGE_SLUG
}

/// The text `embedding::text` gives a `halfvec`: `[a,b,...]`, each element as `float4out` writes it.
fn vector_text(vector: &[f32]) -> String {
    let parts: Vec<String> = vector.iter().map(|&x| float4_out(x)).collect();
    format!("[{}]", parts.join(","))
}

/// The claim and attribution columns a fence row carries, `confidence` as the `REAL` it is.
fn fence_columns(out: &mut Map<String, Value>, r: &FactRecord) {
    out.insert("kind".into(), json!(r.kind));
    out.insert("visibility".into(), json!(r.visibility));
    out.insert("notability".into(), json!(r.notability));
    out.insert("context".into(), json!(r.context));
    out.insert("valid_from".into(), json!(iso(r.valid_from_us)));
    out.insert("valid_until".into(), json!(r.valid_until_us.map(iso)));
    out.insert("source".into(), json!(r.source));
    out.insert("confidence".into(), json!(real(r.confidence)));
    out.insert("claim_metric".into(), json!(r.claim_metric));
    out.insert("claim_value".into(), json!(r.claim_value));
    out.insert("claim_unit".into(), json!(r.claim_unit));
    out.insert("claim_period".into(), json!(r.claim_period));
    out.insert("attributed_to".into(), json!(r.attributed_to));
}

/// `SELECT * FROM facts` for one row, as the single-fact decision reads it: every column, the
/// times as ISO text, `embedding` as the vector's text, and the stamped `trust_tier` and
/// `write_origin`. The store keeps no `source_window` or write-principal columns: they are NULL,
/// the values a row written here carries, as `listFactsByEntity` answers.
fn select_star(r: &FactRecord) -> Value {
    let time = |us: Option<i64>| us.map(iso);
    let mut out = Map::new();
    out.insert("id".into(), json!(r.id));
    out.insert("source_id".into(), json!(r.source_id));
    out.insert("entity_slug".into(), json!(r.entity_slug));
    out.insert("fact".into(), json!(r.fact));
    fence_columns(&mut out, r);
    out.insert("expired_at".into(), json!(time(r.expired_at_us)));
    out.insert("superseded_by".into(), json!(r.superseded_by));
    out.insert("consolidated_at".into(), json!(time(r.consolidated_at_us)));
    out.insert("consolidated_into".into(), json!(r.consolidated_into));
    out.insert("source_session".into(), json!(r.source_session));
    out.insert(
        "embedding".into(),
        json!(r.embedding.as_deref().map(vector_text)),
    );
    out.insert("embedding_model".into(), json!(r.embedding_model));
    out.insert("embedded_text_hash".into(), json!(r.embedded_text_hash));
    out.insert("embedded_at".into(), json!(time(r.embedded_at_us)));
    out.insert("created_at".into(), json!(iso(r.created_at_us)));
    out.insert("row_num".into(), json!(r.row_num));
    out.insert("source_markdown_slug".into(), json!(r.source_markdown_slug));
    out.insert("event_type".into(), json!(r.event_type));
    out.insert("dimension".into(), json!(r.dimension));
    out.insert("value".into(), json!(r.value));
    out.insert("value_hash".into(), json!(r.value_hash));
    out.insert("dim_status".into(), json!(r.dim_status));
    for column in [
        "write_request_id",
        "write_principal_kind",
        "write_principal_id",
        "last_write_request_id",
        "last_write_principal_kind",
        "last_write_principal_id",
        "last_written_at",
        "source_window",
    ] {
        out.insert(column.into(), Value::Null);
    }
    out.insert("write_origin".into(), json!(r.write_origin));
    out.insert("trust_tier".into(), json!(r.tier().as_str()));
    Value::Object(out)
}

/// A claim's scope: `source_id`, `visibility`, the fingerprint and the withdrawal or purge subject.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactScopeArgs {
    pub source_id: String,
    pub visibility: String,
    pub fact_hash: String,
    pub subject: String,
}

impl FactScopeArgs {
    fn check(&self, op: &str) -> Result<()> {
        no_nul(
            op,
            &[
                ("sourceId", &self.source_id),
                ("visibility", &self.visibility),
                ("factHash", &self.fact_hash),
                ("subject", &self.subject),
            ],
        )
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeTargetArgs {
    pub id: f64,
    pub source_id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RelinkQuery {
    pub source_id: String,
    pub after_id: f64,
    /// `since`, an ISO time.
    pub since: Option<String>,
    pub limit: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceArgs {
    pub source_id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UnfencedQuery {
    /// One source, or every source when absent.
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SimilarQuery {
    pub source_id: String,
    pub fact_id: f64,
    pub remote: bool,
    pub min_cosine: f64,
    pub limit: f64,
    /// `privateProvenanceFilterUnderPolicy('c')`, when the caller passes `excludePrivate`.
    pub exclude_private: Option<PrivacyPolicy>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SingleFactQuery {
    pub source_id: String,
    pub entity_slug: Option<String>,
    pub visibility: String,
    pub fact: String,
    pub attributed_to: Option<String>,
    pub page_slug: Option<String>,
    /// `remoteProvenanceFloorSql('facts')` when the caller passes `remoteFloor`.
    pub remote_floor: Option<PrivacyPolicy>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldFenceQuery {
    pub source_id: String,
    pub slug: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawalExpiry {
    pub source_id: String,
    pub visibility: String,
    pub fact: String,
    pub subject: String,
}

impl Store {
    /// `countFactFingerprintLeftovers(sourceId, factHash, visibility, subject)`: the rows of the
    /// fingerprint that a purge under `subject` leaves, outcome markers apart. The SQL counts a row
    /// when `NOT (visibility = $3 AND ($4 = '*' OR entity_slug = $4))` is true, so a row with no
    /// entity counts only when its visibility differs (the comparison is NULL under a subject).
    pub fn count_fact_fingerprint_leftovers(&self, q: &FactScopeArgs) -> Result<u64> {
        q.check("countFactFingerprintLeftovers")?;
        let read = self.read()?;
        let all = q.subject == "*";
        let mut n = 0;
        for row in source_rows(&*read, &q.source_id)? {
            if fact_fingerprint(&row.fact) != q.fact_hash || outcome_marker(&row) {
                continue;
            }
            let other_subject = !all && row.entity_slug.as_deref().is_some_and(|e| e != q.subject);
            if row.visibility != q.visibility || other_subject {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `loadPurgeTarget(id, sourceId)`: the fact row `id` of the source unless it is an outcome
    /// marker, with its fingerprint and its vector as text.
    pub fn load_purge_target(&self, q: &PurgeTargetArgs) -> Result<Value> {
        const OP: &str = "loadPurgeTarget";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let Some(row) = fact_by_number(&*read, OP, "id", q.id)? else {
            return Ok(Value::Null);
        };
        if row.source_id != q.source_id || outcome_marker(&row) {
            return Ok(Value::Null);
        }
        Ok(json!({
            "id": row.id,
            "source_id": row.source_id,
            "visibility": row.visibility,
            "fact": row.fact,
            "entity_slug": row.entity_slug,
            "source_markdown_slug": row.source_markdown_slug,
            "fact_hash": fact_fingerprint(&row.fact),
            "embedding": row.embedding.as_deref().map(vector_text),
            "embedding_model": row.embedding_model,
        }))
    }

    /// `planFactPurgeIds(sourceId, visibility, factHash, subject)`: `{ id }` of every row of the
    /// fingerprint and visibility whose subject is every subject, the row's entity, or an unbacked
    /// name key, outcome markers apart, by id.
    pub fn plan_fact_purge_ids(&self, q: &FactScopeArgs) -> Result<Vec<Value>> {
        q.check("planFactPurgeIds")?;
        let read = self.read()?;
        let mut ids = Vec::new();
        for row in source_rows(&*read, &q.source_id)? {
            if row.visibility != q.visibility
                || fact_fingerprint(&row.fact) != q.fact_hash
                || outcome_marker(&row)
            {
                continue;
            }
            if q.subject == "*"
                || row.entity_slug.as_deref() == Some(q.subject.as_str())
                || unbacked(&*read, &row)?
            {
                ids.push(row.id);
            }
        }
        ids.sort_unstable();
        Ok(ids.into_iter().map(|id| json!({ "id": id })).collect())
    }

    /// `listRelinkCandidateRows({ sourceId, afterId, since, limit })`: the active rows of the source
    /// with no entity and no fence position or page, after `afterId` and (when `since` is set)
    /// created at or after it, by id.
    pub fn list_relink_candidate_rows(&self, q: &RelinkQuery) -> Result<Vec<Value>> {
        const OP: &str = "listRelinkCandidateRows";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let after = bigint(OP, "afterId", q.after_id)?;
        let since = opt_time(OP, "since", &q.since)?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut rows: Vec<FactRecord> = source_rows(&*read, &q.source_id)?
            .into_iter()
            .filter(|r| {
                r.entity_slug.is_none()
                    && r.active(now)
                    && r.row_num.is_none()
                    && r.source_markdown_slug.is_none()
                    && i64::try_from(r.id).is_ok_and(|id| id > after)
                    && since.is_none_or(|at| r.created_at_us >= at)
            })
            .collect();
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .iter()
            .take(limit)
            .map(|r| {
                json!({
                    "id": r.id,
                    "fact": r.fact,
                    "visibility": r.visibility,
                    "context": r.context,
                    "source": r.source,
                    "attributed_to": r.attributed_to,
                })
            })
            .collect())
    }

    /// `countRelinkCandidates(sourceId)`: the active entity-less rows of the source a fence or a
    /// page owns.
    pub fn count_relink_candidates(&self, q: &SourceArgs) -> Result<u64> {
        no_nul("countRelinkCandidates", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        Ok(source_rows(&*read, &q.source_id)?
            .iter()
            .filter(|r| {
                r.entity_slug.is_none()
                    && r.expired_at_us.is_none()
                    && (r.row_num.is_some() || r.source_markdown_slug.is_some())
            })
            .count() as u64)
    }

    /// `listSimilarActiveFacts({ sourceId, factId, remote, excludePrivate, minCosine, limit })`:
    /// `{ anchor, rows }`. The anchor is the withdrawn row's `{ has_embedding, entity_slug }`, null
    /// when no row of the source has the id. With an embedding, the rows are the other active rows
    /// of its entity (a missing entity matches a missing entity) and visibility with a vector of the
    /// same model, `1 - cosine distance` at least `minCosine` (a NaN passes, as in Postgres),
    /// nearest first with NaN last, then by id, at most `limit`; `remote` keeps world rows only.
    pub fn list_similar_active_facts(&self, q: &SimilarQuery) -> Result<Value> {
        const OP: &str = "listSimilarActiveFacts";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let anchor = fact_by_number(&*read, OP, "factId", q.fact_id)?
            .filter(|row| row.source_id == q.source_id);
        let Some(anchor) = anchor else {
            return Ok(json!({ "anchor": null, "rows": [] }));
        };
        let described = json!({
            "has_embedding": anchor.embedding.is_some(),
            "entity_slug": anchor.entity_slug,
        });
        let (Some(target), Some(model)) = (
            anchor.embedding.as_deref(),
            anchor.embedding_model.as_deref(),
        ) else {
            return Ok(json!({ "anchor": described, "rows": [] }));
        };
        let mut ranked: Vec<(f64, u64)> = Vec::new();
        for row in source_rows(&*read, &q.source_id)? {
            let Some(vector) = row.embedding.as_deref() else {
                continue;
            };
            if row.entity_slug != anchor.entity_slug
                || row.visibility != anchor.visibility
                || row.id == anchor.id
                || !row.active(now)
                || row.embedding_model.as_deref() != Some(model)
                || (q.remote && row.visibility != "world")
            {
                continue;
            }
            if vector.len() != target.len() {
                return Err(invalid(format!(
                    "{OP}: different halfvec dimensions {} and {}",
                    vector.len(),
                    target.len()
                )));
            }
            if hidden_by_policy(&*read, &row, &q.exclude_private)? {
                continue;
            }
            let distance = cosine_distance(vector, target);
            let similarity = 1.0 - distance;
            if similarity.is_nan() || similarity >= q.min_cosine {
                ranked.push((distance, row.id));
            }
        }
        // Ascending, NaN after every number; equal distances by id.
        ranked.sort_by(|(da, a), (db, b)| {
            da.is_nan()
                .cmp(&db.is_nan())
                .then(da.total_cmp(db))
                .then(a.cmp(b))
        });
        let rows: Vec<Value> = ranked
            .iter()
            .take(limit)
            .map(|&(distance, id)| {
                let similarity = 1.0 - distance;
                let similarity = if similarity.is_nan() {
                    json!("NaN")
                } else {
                    json!(similarity)
                };
                json!({ "id": id, "similarity": similarity })
            })
            .collect();
        Ok(json!({ "anchor": described, "rows": rows }))
    }

    /// `findActiveSingleFact({ sourceId, entitySlug, visibility, fact, attributedTo, pageSlug })`:
    /// the lowest-id active row of the entity (NULL equals NULL) and visibility with the same
    /// fingerprint whose speaker slot fits (`attributedTo` unset, the row's unset, or equal) and
    /// that sits on `pageSlug` (a non-empty slug) or, with no `pageSlug`, on no owned memory page.
    /// An empty `pageSlug` matches nothing. The row is `SELECT *`.
    pub fn find_active_single_fact(&self, q: &SingleFactQuery) -> Result<Value> {
        const OP: &str = "findActiveSingleFact";
        no_nul(OP, &[("sourceId", &q.source_id), ("fact", &q.fact)])?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let hash = fact_fingerprint(&q.fact);
        let page = q.page_slug.as_deref();
        let mut found: Option<FactRecord> = None;
        for row in source_rows(&*read, &q.source_id)? {
            let fits_page = match page {
                Some("") => false,
                Some(slug) => row.source_markdown_slug.as_deref() == Some(slug),
                None => !row.on_owned_memory_page(),
            };
            if row.entity_slug == q.entity_slug
                && row.visibility == q.visibility
                && row.active(now)
                && q.attributed_to
                    .as_ref()
                    .is_none_or(|who| row.attributed_to.as_ref().is_none_or(|a| a == who))
                && fits_page
                && fact_fingerprint(&row.fact) == hash
                && found.as_ref().is_none_or(|best| row.id < best.id)
                && !hidden_by_policy(&*read, &row, &q.remote_floor)?
            {
                found = Some(row);
            }
        }
        Ok(found.as_ref().map_or(Value::Null, select_star))
    }

    /// `listUnfencedFactRows({ sourceId? })`: the active rows with no fence position and no ontology
    /// dimension of one source or every source, by source, then entity (no entity last), then id,
    /// with whether the entity has a live page of the source.
    pub fn list_unfenced_fact_rows(&self, q: &UnfencedQuery) -> Result<Vec<Value>> {
        const OP: &str = "listUnfencedFactRows";
        let read = self.read()?;
        let candidates = match &q.source_id {
            Some(source) => {
                no_nul(OP, &[("sourceId", source)])?;
                source_rows(&*read, source)?
            }
            None => rows_under(&*read, &[keys::FACT, ROW])?,
        };
        let mut rows: Vec<FactRecord> = candidates
            .into_iter()
            .filter(|r| r.row_num.is_none() && r.expired_at_us.is_none() && r.dimension.is_none())
            .collect();
        rows.sort_by(|a, b| {
            a.source_id
                .cmp(&b.source_id)
                .then(a.entity_slug.is_none().cmp(&b.entity_slug.is_none()))
                .then(a.entity_slug.cmp(&b.entity_slug))
                .then(a.id.cmp(&b.id))
        });
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let page_exists = match &r.entity_slug {
                Some(slug) => read_page(&*read, &r.source_id, slug)?
                    .is_some_and(|p| p.deleted_at_us.is_none()),
                None => false,
            };
            let mut row = Map::new();
            row.insert("id".into(), json!(r.id));
            row.insert("source_id".into(), json!(r.source_id));
            row.insert("entity_slug".into(), json!(r.entity_slug));
            row.insert("fact".into(), json!(r.fact));
            fence_columns(&mut row, r);
            row.insert("page_exists".into(), json!(page_exists));
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `listHeldFenceFactRows(sourceId, slug)`: the active rows that sit on page `slug` with a fence
    /// position, a conversation extractor's own rows apart, by position, then id.
    pub fn list_held_fence_fact_rows(&self, q: &HeldFenceQuery) -> Result<Vec<Value>> {
        no_nul(
            "listHeldFenceFactRows",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let mut rows: Vec<FactRecord> = page_rows(&*read, &q.source_id, &q.slug)?
            .into_iter()
            .filter(|r| r.row_num.is_some() && r.expired_at_us.is_none() && !r.conversation_slot())
            .collect();
        rows.sort_by_key(|r| (r.row_num, r.id));
        Ok(rows
            .iter()
            .map(|r| {
                let mut row = Map::new();
                row.insert("id".into(), json!(r.id));
                row.insert("row_num".into(), json!(r.row_num));
                row.insert("fact".into(), json!(r.fact));
                row.insert("entity_slug".into(), json!(r.entity_slug));
                fence_columns(&mut row, r);
                Value::Object(row)
            })
            .collect())
    }

    /// `listWithdrawalSlugs(sourceId, visibility, factHash, subject)`: `{ slug }` for each distinct
    /// page key (`COALESCE(source_markdown_slug, entity_slug)`) of the active rows a withdrawal of
    /// the claim under `subject` expires. Sorted; the SQL gives no order.
    pub fn list_withdrawal_slugs(&self, q: &FactScopeArgs) -> Result<Vec<Value>> {
        q.check("listWithdrawalSlugs")?;
        let read = self.read()?;
        let mut slugs = BTreeSet::new();
        for row in source_rows(&*read, &q.source_id)? {
            if row.visibility != q.visibility
                || fact_fingerprint(&row.fact) != q.fact_hash
                || row.expired_at_us.is_some()
            {
                continue;
            }
            if !withdrawal_covers(&*read, &row, &q.subject)? {
                continue;
            }
            if let Some(key) = row
                .source_markdown_slug
                .clone()
                .or_else(|| row.entity_slug.clone())
            {
                slugs.insert(key);
            }
        }
        Ok(slugs
            .into_iter()
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }

    /// `expireFactsByWithdrawal({ sourceId, visibility, fact, subject })`: expires every active row
    /// of the claim's fingerprint, visibility and subject now and closes its valid time at now
    /// (`LEAST(COALESCE(valid_until, now()), now())`); `{ id }` of each, by id.
    pub fn expire_facts_by_withdrawal(&self, q: &WithdrawalExpiry) -> Result<Vec<Value>> {
        const OP: &str = "expireFactsByWithdrawal";
        no_nul(
            OP,
            &[
                ("sourceId", &q.source_id),
                ("visibility", &q.visibility),
                ("fact", &q.fact),
                ("subject", &q.subject),
            ],
        )?;
        let now = self.env.now_micros();
        let hash = fact_fingerprint(&q.fact);
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut expired = Vec::new();
            for old in source_rows(tx, &q.source_id)? {
                if old.visibility != q.visibility
                    || old.expired_at_us.is_some()
                    || fact_fingerprint(&old.fact) != hash
                    || !withdrawal_covers(tx, &old, &q.subject)?
                {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                new.valid_until_us = Some(old.valid_until_us.map_or(now, |until| until.min(now)));
                write_fact(tx, trust, Some(&old), &new)?;
                expired.push(old.id);
            }
            expired.sort_unstable();
            Ok(expired.into_iter().map(|id| json!({ "id": id })).collect())
        })
    }
}

/// The earliest withdrawal `gbrain_preserve_fact_withdrawal` finds for `row`, as the time it was
/// made: a withdrawal of the same source and visibility, with the claim's fingerprint (or its v1
/// fingerprint), and a subject that reaches the row. A row on a member page (`memory/members/..`)
/// matches only that page's own withdrawals (GST-2346); any other row matches subject `*`, its
/// entity, or, on an unbacked name key, any subject but an owned memory page (GBRA-574).
pub(crate) fn earliest_withdrawal(read: &dyn KvRead, row: &FactRecord) -> Result<Option<i64>> {
    let ledger = withdrawals_of(read, &row.source_id, &row.visibility, &row.fact)?;
    if ledger.is_empty() {
        return Ok(None);
    }
    let member = row
        .source_markdown_slug
        .as_deref()
        .filter(|s| s.starts_with(MEMBER_PAGE_PREFIX));
    let unbacked = member.is_none() && unbacked(read, row)?;
    let mut earliest: Option<i64> = None;
    for (subject, at) in ledger {
        let covers = match member {
            Some(slug) => subject == slug,
            None => {
                subject == "*"
                    || row.entity_slug.as_deref() == Some(subject.as_str())
                    || (unbacked && !owned_memory_subject(&subject))
            }
        };
        if covers {
            earliest = Some(earliest.map_or(at, |e| e.min(at)));
        }
    }
    Ok(earliest)
}

/// A withdrawal under `subject` reaches `row`: every subject, the row's entity, an unbacked name
/// key (unless the subject is an owned memory page), or the owned memory page the row sits on.
pub(super) fn withdrawal_covers(
    read: &dyn KvRead,
    row: &FactRecord,
    subject: &str,
) -> Result<bool> {
    Ok(subject == "*"
        || row.entity_slug.as_deref() == Some(subject)
        || (unbacked(read, row)? && !owned_memory_subject(subject))
        || (row.on_owned_memory_page() && row.source_markdown_slug.as_deref() == Some(subject)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_text_writes_each_element_as_float4out() {
        assert_eq!(vector_text(&[1.0, 0.0, 0.5, -0.25]), "[1,0,0.5,-0.25]");
        assert_eq!(vector_text(&[]), "[]");
    }

    #[test]
    fn owned_memory_subjects_are_member_pages_and_the_scope_page() {
        assert!(owned_memory_subject("memory/members/alice"));
        assert!(owned_memory_subject("memory/scope"));
        assert!(!owned_memory_subject("memory/scoped"));
        assert!(!owned_memory_subject("*"));
    }
}
