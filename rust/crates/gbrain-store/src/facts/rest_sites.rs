//! Four reads and one write of the facts store that callers reach from the trust, repair and purge paths
//! (src/core/engine-sql/facts-trust.ts and facts-purge.ts): the claim-conflict pairs, the pending proposals that name a
//! fact, the live page an entity names, and the facts a purge expires with their pages.
//!
//! Shared rules, read from the SQL:
//!
//! - A claim's as-of bucket is `claimBucketSql`: the UTC day of `valid_from`, or the ISO week, month, quarter or year
//!   its period names (`weekly`, `monthly`, `quarterly`, `annual`, `annually`, `yearly`, compared trimmed of spaces and
//!   lowercased).
//! - A text comparison is a byte comparison, and a NUL byte in a text argument is refused whether or not a row would
//!   match, as Postgres refuses the bound parameter.
//! - `now()` is the store clock, read once for the call.

use super::privacy::page_hidden;
use super::repair::{PAGE_EXTRACTION_SOURCES, context_head};
use super::{
    FactRecord, PrivacyPolicy, hidden_by_deleted_page, hidden_by_policy, hidden_by_quarantine,
    source_rows, write_fact,
};
use crate::Store;
use crate::env::{civil_from_days, days_from_civil};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::eval_capture::decide_proposals::all_proposals;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::trust::TrustPolicy;
use crate::trust::proposals::pending_fact_supersessions;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const MICROS_PER_DAY: i64 = 86_400_000_000;

/// `listClaimConflictPairs(sourceId, auditSources, cap)` and `countClaimConflictPairs(sourceId, auditSources)`
/// (`cap` is ignored by the count).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimPairArgs {
    pub source_id: String,
    pub audit_sources: Vec<String>,
    pub cap: f64,
}

/// `readLiveFactEntityPage(sourceId, slug, excludePrivate)`: `policy` is the remote read floor the TypeScript member
/// judged, absent when the caller did not ask for it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveEntityPageArgs {
    pub source_id: String,
    pub slug: String,
    pub policy: Option<PrivacyPolicy>,
}

/// `listContestedProposalPairs(ids, policy)`: `remote` keeps world facts only, `exclude_private` is the fact privacy
/// policy, and `min_trust` and `suppress_flagged` are the read eligibility.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ContestedArgs {
    pub ids: Vec<f64>,
    pub remote: bool,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
}

/// `expireFactsOfGonePages(sourceIds, slugs)`: the pairs, by position.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GonePagesArgs {
    pub source_ids: Vec<String>,
    pub slugs: Vec<String>,
}

/// `claimBucketSql`: the cadence a period names, or `None` for the day bucket.
fn cadence(period: Option<&str>) -> Option<&'static str> {
    // `lower(btrim(...))`: btrim strips spaces only.
    match period?.trim_matches(' ').to_ascii_lowercase().as_str() {
        "weekly" => Some("week"),
        "monthly" => Some("month"),
        "quarterly" => Some("quarter"),
        "annual" | "annually" | "yearly" => Some("year"),
        _ => None,
    }
}

/// `to_char(valid_from AT TIME ZONE 'UTC', ...)` for the cadence of `period`.
fn claim_bucket(period: Option<&str>, valid_from_us: i64) -> String {
    let days = valid_from_us.div_euclid(MICROS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    match cadence(period) {
        Some("year") => format!("{y:04}"),
        Some("quarter") => format!("{y:04}-Q{}", (m - 1) / 3 + 1),
        Some("month") => format!("{y:04}-{m:02}"),
        Some("week") => {
            // ISO 8601: the week belongs to the year of its Thursday.
            let weekday = (days + 3).rem_euclid(7) + 1;
            let thursday = days + 4 - weekday;
            let (iso_year, _, _) = civil_from_days(thursday);
            let week = (thursday - days_from_civil(iso_year, 1, 1)) / 7 + 1;
            format!("{iso_year:04}-W{week:02}")
        }
        _ => format!("{y:04}-{m:02}-{d:02}"),
    }
}

/// One active typed claim of the source, with its bucket.
struct Claim<'a> {
    row: &'a FactRecord,
    value: f64,
    bucket: String,
}

/// The `(new, old)` pairs of the source's unproposed claim conflicts, ordered by `(new id, old id)`.
fn conflict_pairs(
    read: &dyn KvRead,
    source_id: &str,
    audits: &[String],
    now: i64,
) -> Result<Vec<Value>> {
    let rows = source_rows(read, source_id)?;
    let claims: Vec<Claim> = rows
        .iter()
        .filter(|r| r.active(now) && !audits.contains(&r.source))
        .filter_map(|r| {
            let value = r.claim_value?;
            r.entity_slug.as_ref()?;
            r.claim_metric.as_ref()?;
            Some(Claim {
                row: r,
                value,
                bucket: claim_bucket(r.claim_period.as_deref(), r.valid_from_us),
            })
        })
        .collect();
    let proposed: HashSet<(i64, i64)> = all_proposals(read)?
        .into_iter()
        .filter(|p| p.source_id == source_id)
        .map(|p| {
            (
                p.new_fact_id.min(p.old_fact_id),
                p.new_fact_id.max(p.old_fact_id),
            )
        })
        .collect();
    let pending = pending_fact_supersessions(read)?;
    let mut slots: HashMap<(&str, &str, &str, &str), Vec<&Claim>> = HashMap::new();
    for c in &claims {
        let r = c.row;
        let key = (
            r.entity_slug.as_deref().unwrap_or(""),
            r.visibility.as_str(),
            r.claim_metric.as_deref().unwrap_or(""),
            c.bucket.as_str(),
        );
        slots.entry(key).or_default().push(c);
    }
    let mut pairs: Vec<(u64, u64, &Claim, &Claim)> = Vec::new();
    for group in slots.values() {
        for n in group {
            for o in group {
                if n.row.id == o.row.id
                    || o.value == n.value
                    || o.row.claim_unit != n.row.claim_unit
                    || o.row.claim_period != n.row.claim_period
                {
                    continue;
                }
                let owned = n.row.on_owned_memory_page() || o.row.on_owned_memory_page();
                if owned
                    && !(o.row.source_markdown_slug.is_some()
                        && o.row.source_markdown_slug == n.row.source_markdown_slug)
                {
                    continue;
                }
                let older = o.row.valid_from_us < n.row.valid_from_us
                    || (o.row.valid_from_us == n.row.valid_from_us && o.row.id < n.row.id);
                if !older {
                    continue;
                }
                let (a, b) = (n.row.id as i64, o.row.id as i64);
                if proposed.contains(&(a.min(b), a.max(b))) || pending.contains(&(a, b)) {
                    continue;
                }
                pairs.push((n.row.id, o.row.id, n, o));
            }
        }
    }
    pairs.sort_by_key(|(n, o, _, _)| (*n, *o));
    Ok(pairs
        .into_iter()
        .map(|(n, o, new, old)| {
            json!({
                "new_fact_id": n,
                "old_fact_id": o,
                "entity_slug": new.row.entity_slug,
                "visibility": new.row.visibility,
                "claim_metric": new.row.claim_metric,
                "claim_unit": new.row.claim_unit,
                "claim_period": new.row.claim_period,
                "bucket": new.bucket,
                "new_value": new.value,
                "old_value": old.value,
            })
        })
        .collect())
}

fn cap_of(cap: f64) -> Result<usize> {
    if !cap.is_finite() || cap.fract() != 0.0 || cap.abs() > 9.0e15 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!(
                "listClaimConflictPairs: invalid input syntax for type bigint: \"{cap}\" (cap)"
            ),
        ));
    }
    if cap < 0.0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            "listClaimConflictPairs: LIMIT must not be negative",
        ));
    }
    Ok(cap as usize)
}

fn claim_args_ok(op: &str, q: &ClaimPairArgs) -> Result<()> {
    no_nul(op, &[("sourceId", &q.source_id)])?;
    for source in &q.audit_sources {
        no_nul(op, &[("auditSources", source)])?;
    }
    Ok(())
}

/// The pages of the source a purge removes, the rule that expires `row` with them, if any: the new row to write.
fn expired_with_pages(
    read: &dyn KvRead,
    row: &FactRecord,
    gone: &[(&str, &str)],
    now: i64,
) -> Result<Option<FactRecord>> {
    if row.expired_at_us.is_some() {
        return Ok(None);
    }
    let mine = || {
        gone.iter()
            .filter(|(source, _)| *source == row.source_id)
            .map(|(_, slug)| *slug)
    };
    let filed = row
        .source_markdown_slug
        .as_deref()
        .is_some_and(|s| mine().any(|g| g == s));
    let mut new = row.clone();
    new.expired_at_us = Some(now);
    new.row_num = None;
    // 1. Filed on a gone page, not an ontology observation.
    if filed && row.dimension.is_none() {
        return Ok(Some(new));
    }
    // 2. A conversation fact's slot gives up the slot with the row.
    if filed && row.dimension.is_some() && row.row_num.is_some() && row.conversation_slot() {
        new.dimension = None;
        new.value = None;
        new.value_hash = None;
        new.dim_status = None;
        return Ok(Some(new));
    }
    // 3. Extracted from a gone page and filed on none.
    let extracted = row.source_markdown_slug.is_none()
        && PAGE_EXTRACTION_SOURCES.contains(&row.source.as_str())
        && row.context.as_deref().is_some_and(|c| {
            let head = context_head(c);
            mine().any(|g| g == head)
        });
    if extracted {
        return Ok(Some(new));
    }
    // 4. About a gone page that no other page row holds.
    if let Some(entity) = row.entity_slug.as_deref()
        && mine().any(|g| g == entity)
    {
        let held_elsewhere = match row.source_markdown_slug.as_deref() {
            None => false,
            Some(slug) => slug != entity && read_page(read, &row.source_id, slug)?.is_some(),
        };
        if !held_elsewhere {
            return Ok(Some(new));
        }
    }
    Ok(None)
}

impl Store {
    /// `listClaimConflictPairs(sourceId, auditSources, cap)`: the unproposed same-slot claim conflicts of the source,
    /// newest over oldest, by `(new id, old id)`, at most `cap`.
    pub fn list_claim_conflict_pairs(&self, q: &ClaimPairArgs) -> Result<Vec<Value>> {
        const OP: &str = "listClaimConflictPairs";
        claim_args_ok(OP, q)?;
        let cap = cap_of(q.cap)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut pairs = conflict_pairs(&*read, &q.source_id, &q.audit_sources, now)?;
        pairs.truncate(cap);
        Ok(pairs)
    }

    /// `countClaimConflictPairs(sourceId, auditSources)`: `{ n }`, how many conflicts the list holds without a cap.
    pub fn count_claim_conflict_pairs(&self, q: &ClaimPairArgs) -> Result<Value> {
        claim_args_ok("countClaimConflictPairs", q)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let pairs = conflict_pairs(&*read, &q.source_id, &q.audit_sources, now)?;
        Ok(json!({ "n": pairs.len() }))
    }

    /// `readLiveFactEntityPage(sourceId, slug, excludePrivate)`: `{ slug, type }` of the live page, `null` for none
    /// (a soft-deleted page, or one the floor hides).
    pub fn read_live_fact_entity_page(&self, q: &LiveEntityPageArgs) -> Result<Value> {
        no_nul(
            "readLiveFactEntityPage",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let Some(page) =
            read_page(&*read, &q.source_id, &q.slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(Value::Null);
        };
        if let Some(policy) = &q.policy
            && page_hidden(&*read, &page, policy)?
        {
            return Ok(Value::Null);
        }
        Ok(json!({ "slug": page.slug, "type": page.page_type }))
    }

    /// `listContestedProposalPairs(ids, policy)`: the pending decide proposals that name any of `ids` as their new or
    /// old fact, both facts readable under the policy, by proposal id, then by the order `ids` names them.
    pub fn list_contested_proposal_pairs(&self, q: &ContestedArgs) -> Result<Vec<Value>> {
        const OP: &str = "listContestedProposalPairs";
        let mut ids = Vec::with_capacity(q.ids.len());
        for id in &q.ids {
            if !id.is_finite() || id.fract() != 0.0 || id.abs() > 9.0e15 {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{OP}: invalid input syntax for type bigint: \"{id}\""),
                ));
            }
            ids.push(*id as i64);
        }
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), q.suppress_flagged)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let readable = |row: &FactRecord| -> Result<bool> {
            Ok(row.active(now)
                && (!q.remote || row.visibility == "world")
                && !hidden_by_policy(&*read, row, &q.exclude_private)?
                && !hidden_by_deleted_page(&*read, row)?
                && !hidden_by_quarantine(&*read, row)?
                && trust.admits(&*read, "facts", row.id, row.tier())?)
        };
        let mut out = Vec::new();
        for p in all_proposals(&*read)?
            .into_iter()
            .filter(|p| p.status == "pending")
        {
            let named: Vec<usize> = (0..ids.len())
                .filter(|&i| ids[i] == p.new_fact_id || ids[i] == p.old_fact_id)
                .collect();
            if named.is_empty() {
                continue;
            }
            let fact = |id: i64| -> Result<Option<FactRecord>> {
                Ok(u64::try_from(id)
                    .ok()
                    .map(|id| super::read_fact(&*read, id))
                    .transpose()?
                    .flatten()
                    .filter(|f| f.source_id == p.source_id))
            };
            let (Some(new), Some(old)) = (fact(p.new_fact_id)?, fact(p.old_fact_id)?) else {
                continue;
            };
            if !(readable(&new)? && readable(&old)?) {
                continue;
            }
            for i in named {
                out.push(json!({
                    "id": p.id,
                    "delivered": ids[i],
                    "new_fact_id": p.new_fact_id,
                    "old_fact_id": p.old_fact_id,
                }));
            }
        }
        Ok(out)
    }

    /// `expireFactsOfGonePages(sourceIds, slugs)`: after a purge removes the pages, expires now the facts filed on them,
    /// their conversation slots (which give up the slot), the facts extracted from them and filed on none, and the facts
    /// about them that no other page row holds. The first rule that matches a row decides it. The pairs are by position;
    /// a pair with no partner matches nothing.
    pub fn expire_facts_of_gone_pages(&self, q: &GonePagesArgs) -> Result<Value> {
        const OP: &str = "expireFactsOfGonePages";
        for source in &q.source_ids {
            no_nul(OP, &[("sourceIds", source)])?;
        }
        for slug in &q.slugs {
            no_nul(OP, &[("slugs", slug)])?;
        }
        let gone: Vec<(&str, &str)> = q
            .source_ids
            .iter()
            .zip(&q.slugs)
            .map(|(s, g)| (s.as_str(), g.as_str()))
            .collect();
        let sources: HashSet<&str> = gone.iter().map(|(s, _)| *s).collect();
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut sources: Vec<&str> = sources.iter().copied().collect();
            sources.sort_unstable();
            let mut writes = Vec::new();
            for source in sources {
                for row in source_rows(tx, source)? {
                    if let Some(new) = expired_with_pages(tx, &row, &gone, now)? {
                        writes.push((row, new));
                    }
                }
            }
            for (old, new) in &writes {
                write_fact(tx, trust, Some(old), new)?;
            }
            Ok(Value::Null)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i64, m: i64, d: i64) -> i64 {
        days_from_civil(y, m, d) * MICROS_PER_DAY + 3_600_000_000
    }

    #[test]
    fn a_period_with_no_cadence_buckets_by_the_utc_day() {
        assert_eq!(claim_bucket(None, at(2026, 3, 1)), "2026-03-01");
        assert_eq!(claim_bucket(Some("daily"), at(2026, 3, 1)), "2026-03-01");
    }

    #[test]
    fn each_cadence_names_its_year_quarter_month_or_week() {
        let t = at(2026, 5, 17);
        assert_eq!(claim_bucket(Some("annual"), t), "2026");
        assert_eq!(claim_bucket(Some(" Yearly "), t), "2026");
        assert_eq!(claim_bucket(Some("quarterly"), t), "2026-Q2");
        assert_eq!(claim_bucket(Some("monthly"), t), "2026-05");
        assert_eq!(claim_bucket(Some("weekly"), t), "2026-W20");
    }

    #[test]
    fn a_week_belongs_to_the_year_of_its_thursday() {
        assert_eq!(claim_bucket(Some("weekly"), at(2026, 1, 1)), "2026-W01");
        assert_eq!(claim_bucket(Some("weekly"), at(2024, 12, 30)), "2025-W01");
        assert_eq!(claim_bucket(Some("weekly"), at(2021, 1, 3)), "2020-W53");
    }
}
