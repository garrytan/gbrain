//! Derivation trust: the derived-row trust writes of src/core/engine-sql/derivation-trust.ts.
//!
//! `lowerTrustTier`, `countDerivedRowTaint`, `countDerivedFactTaint` and
//! `stampPageFrontmatter` read and write the page, take, timeline and fact records; this module
//! keeps no key of its own. The `derivation_inputs` edges are not kept here.

use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::pages::{
    PageRecord, all_pages, read_page, read_page_by_id, write_page, write_page_setting_trust,
};
use crate::trust::{TrustTable, TrustTier, set_row_trust};
use crate::{Store, keys, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `lowerTrustTier(spec)`: `table` is `facts`, `takes`, `timeline_entries` or `pages`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LowerTierSpec {
    pub table: String,
    pub ids: Vec<i64>,
    pub tier: String,
    #[serde(default)]
    pub origin: Option<Value>,
}

/// `countDerivedRowTaint(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaintCountQuery {
    pub table: String,
}

/// `stampPageFrontmatter(spec)`: `entries` are the keys the stamp merges into the frontmatter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontmatterStampSpec {
    #[serde(rename = "match")]
    pub match_kind: String,
    pub source_id: String,
    pub slugs: Vec<String>,
    pub entries: Map<String, Value>,
}

/// PostgreSQL's `jsonb ? key`: an object with the top-level key, an array with the string as an
/// element, or the string itself.
fn has_key(value: Option<&Value>, key: &str) -> bool {
    match value {
        Some(Value::Object(map)) => map.contains_key(key),
        Some(Value::Array(items)) => items.iter().any(|v| v.as_str() == Some(key)),
        Some(Value::String(s)) => s == key,
        _ => false,
    }
}

/// `{ derived, external }` over `(write_origin, trust_tier)` pairs.
fn taint_counts<'a>(rows: impl Iterator<Item = (Option<&'a Value>, TrustTier)>) -> Value {
    let (mut derived, mut external) = (0u64, 0u64);
    for (origin, tier) in rows {
        if has_key(origin, "taint_inputs") {
            derived += 1;
            if tier == TrustTier::ExternalUntrusted {
                external += 1;
            }
        }
    }
    json!({ "derived": derived, "external": external })
}

impl Store {
    /// `lowerTrustTier(table, ids, tier, origin)`: sets `tier` and `origin` on each listed row of
    /// `facts`, `takes`, `timeline_entries` or `pages` whose stored tier ranks above `tier`, and
    /// resolves the ids it lowered in id order. A page is lowered deleted or not and keeps its
    /// knowledge revision (the revision trigger reads no trust column); a fact, take or timeline
    /// row keeps every other column, its write receipt included, since no content column changed.
    /// The stamp (`trust::stamp`) runs as PGLite's `trust_tier_stamp` trigger runs for an UPDATE
    /// that names both columns.
    pub fn lower_trust_tier(&self, spec: &LowerTierSpec) -> Result<Vec<u64>> {
        let table = match spec.table.as_str() {
            "facts" => TrustTable::Facts,
            "takes" => TrustTable::Takes,
            "timeline_entries" => TrustTable::TimelineEntries,
            "pages" => TrustTable::Pages,
            other => {
                return Err(StoreError::invalid(format!(
                    "lowerTrustTier: unknown table \"{other}\""
                )));
            }
        };
        let tier = TrustTier::parse(&spec.tier).ok_or_else(|| {
            StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "lowerTrustTier: \"{}\" is not a trust tier ({}_trust_tier_check)",
                    spec.tier, spec.table
                ),
            )
        })?;
        let ids: BTreeSet<u64> = spec
            .ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let above = |stored: TrustTier| stored.rank() > tier.rank();
        let trust = self.write_trust()?;
        self.write(|tx| {
            let mut lowered = Vec::new();
            match table {
                TrustTable::Pages => {
                    for &id in &ids {
                        let Some(page) = read_page_by_id(&*tx, id)? else {
                            continue;
                        };
                        if !above(TrustTier::stored(page.trust_tier.as_deref())) {
                            continue;
                        }
                        write_page_setting_trust(tx, &page, Some((tier, spec.origin.clone())))?;
                        lowered.push(id);
                    }
                }
                TrustTable::Facts => {
                    for &id in &ids {
                        let Some(old) = crate::facts::read_fact(&*tx, id)? else {
                            continue;
                        };
                        if !above(old.tier()) {
                            continue;
                        }
                        let mut new = old.clone();
                        new.trust_tier = tier.as_str().to_owned();
                        new.write_origin = spec.origin.clone();
                        crate::facts::write_fact(tx, &trust, Some(&old), &new)?;
                        lowered.push(id);
                    }
                }
                TrustTable::Takes => {
                    for &id in &ids {
                        let Some(mut take) = crate::takes::read_take(&*tx, id)? else {
                            continue;
                        };
                        if !above(take.trust.tier()) {
                            continue;
                        }
                        take.trust = set_row_trust(table, &take.trust, tier, spec.origin.clone())?;
                        crate::takes::write_take(tx, &take)?;
                        lowered.push(id);
                    }
                }
                TrustTable::TimelineEntries => {
                    let mut entries = Vec::new();
                    let mut failure = None;
                    scan_prefix(&*tx, &[keys::TIMELINE], false, &mut |_, v| {
                        match serde_json::from_slice::<crate::timeline::TimelineRecord>(v) {
                            Ok(r) if ids.contains(&r.id) => entries.push(r),
                            Ok(_) => {}
                            Err(e) => failure = Some(StoreError::from(e)),
                        }
                        failure.is_none()
                    })?;
                    if let Some(e) = failure {
                        return Err(e);
                    }
                    entries.sort_by_key(|r| r.id);
                    for mut entry in entries {
                        if !above(entry.trust.tier()) {
                            continue;
                        }
                        entry.trust =
                            set_row_trust(table, &entry.trust, tier, spec.origin.clone())?;
                        put_json(
                            tx,
                            &keys::timeline(entry.page_id, &entry.date, entry.id),
                            &entry,
                        )?;
                        lowered.push(entry.id);
                    }
                }
            }
            Ok(lowered)
        })
    }

    /// `countDerivedRowTaint(table)`: the rows of `takes`, `timeline_entries` or `pages` whose
    /// write origin has `taint_inputs`, and how many of those are external_untrusted.
    pub fn count_derived_row_taint(&self, q: &TaintCountQuery) -> Result<Value> {
        let read = self.read()?;
        match q.table.as_str() {
            "pages" => {
                let pages = all_pages(&*read)?;
                Ok(taint_counts(pages.iter().map(|p| {
                    (
                        p.write_origin.as_ref(),
                        TrustTier::stored(p.trust_tier.as_deref()),
                    )
                })))
            }
            "takes" => {
                let takes = crate::takes::all_takes(&*read)?;
                Ok(taint_counts(
                    takes
                        .iter()
                        .map(|t| (t.trust.write_origin.as_ref(), t.trust.tier())),
                ))
            }
            "timeline_entries" => {
                let mut rows = Vec::new();
                let mut failure = None;
                scan_prefix(&*read, &[keys::TIMELINE], false, &mut |_, v| {
                    match serde_json::from_slice::<crate::timeline::TimelineRecord>(v) {
                        Ok(r) => rows.push(r.trust),
                        Err(e) => failure = Some(StoreError::from(e)),
                    }
                    failure.is_none()
                })?;
                if let Some(e) = failure {
                    return Err(e);
                }
                Ok(taint_counts(
                    rows.iter().map(|t| (t.write_origin.as_ref(), t.tier())),
                ))
            }
            other => Err(StoreError::invalid(format!(
                "countDerivedRowTaint: unknown table \"{other}\""
            ))),
        }
    }

    /// `countDerivedFactTaint()`: the facts whose write origin has `taint_inputs`, and how many of
    /// those are stamped external_untrusted.
    pub fn count_derived_fact_taint(&self) -> Result<Value> {
        let read = self.read()?;
        let facts = crate::facts::trust_reads::all_fact_rows(&*read)?;
        // The fact's stored text is compared as stored (`trust_tier = 'external_untrusted'`).
        Ok(taint_counts(facts.iter().map(|f| {
            let external = f.trust_tier == TrustTier::ExternalUntrusted.as_str();
            (
                f.write_origin.as_ref(),
                if external {
                    TrustTier::ExternalUntrusted
                } else {
                    TrustTier::Unknown
                },
            )
        })))
    }

    /// `stampPageFrontmatter(spec)`: merges `entries` into the frontmatter of the named pages of
    /// the source: `retired` stamps soft-deleted pages, `atom_source_hash` live pages of type
    /// `atom`. A page whose frontmatter changes takes a new knowledge revision and its text
    /// projection is cleared, as the revision trigger does; `updated_at` does not change. A page
    /// the stamp leaves as it was is not written.
    pub fn stamp_page_frontmatter(&self, spec: &FrontmatterStampSpec) -> Result<()> {
        let op = "stampPageFrontmatter";
        let deleted = match spec.match_kind.as_str() {
            "retired" => true,
            "atom_source_hash" => false,
            other => {
                return Err(StoreError::invalid(format!(
                    "{op}: unknown match \"{other}\""
                )));
            }
        };
        no_nul(op, &[("sourceId", spec.source_id.as_str())])?;
        let slugs: BTreeSet<&str> = spec.slugs.iter().map(String::as_str).collect();
        self.write(|tx| {
            for &slug in &slugs {
                let Some(mut page) = read_page(&*tx, &spec.source_id, slug)? else {
                    continue;
                };
                if !stamp_applies(&page, deleted) {
                    continue;
                }
                let before = page.frontmatter.clone();
                for (k, v) in &spec.entries {
                    page.frontmatter.insert(k.clone(), v.clone());
                }
                if page.frontmatter == before {
                    continue;
                }
                page.knowledge_revision = self.env.new_uuid();
                page.text_projection_revision = None;
                write_page(tx, &page)?;
            }
            Ok(())
        })
    }
}

fn stamp_applies(page: &PageRecord, deleted: bool) -> bool {
    if deleted {
        page.deleted_at_us.is_some()
    } else {
        page.deleted_at_us.is_none() && page.page_type == "atom"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonb_key_test_matches_object_keys_array_strings_and_scalars() {
        assert!(has_key(
            Some(&json!({ "taint_inputs": [] })),
            "taint_inputs"
        ));
        assert!(has_key(Some(&json!(["taint_inputs"])), "taint_inputs"));
        assert!(has_key(Some(&json!("taint_inputs")), "taint_inputs"));
        assert!(!has_key(
            Some(&json!({ "channel": "taint_inputs" })),
            "taint_inputs"
        ));
        assert!(!has_key(None, "taint_inputs"));
    }
}
