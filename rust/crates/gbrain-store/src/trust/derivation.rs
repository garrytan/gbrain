//! Derivation trust: the `derivation_inputs` edges (src/schema.sql) and the derived-row trust
//! writes of src/core/engine-sql/derivation-trust.ts.
//!
//! An edge says the row `derived_table`/`derived_id` was derived from the row
//! `input_table`/`input_id`. Ids are text, as in the table: a numeric row id, or `source:slug` for
//! a page that did not exist when the derivation read it. Keys:
//! - `t 0x09 derived_table \0 derived_id \0 input_table \0 input_id` -> [`EdgeRecord`].
//! - `t 0x0A input_table \0 input_id \0 derived_table \0 derived_id` -> empty: the table's
//!   `(input_table, input_id)` index, for [`Store::list_derivation_dependents`].
//!
//! The table has no foreign key to the rows it names, so deleting a page, fact or take keeps its
//! edges. Deleting a source removes the edges recorded with it (`ON DELETE CASCADE`,
//! [`remove_source_rows`]). The rest of this module are the trust writes and counts that read the
//! page, take, timeline and fact records: `lowerTrustTier` (pages), `countDerivedRowTaint`,
//! `countDerivedFactTaint` and `stampPageFrontmatter`.

use crate::error::{CONSTRAINT_VIOLATION, Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{
    PageRecord, all_pages, read_page, read_page_by_id, write_page, write_page_setting_trust,
};
use crate::sources::require_source;
use crate::trust::TrustTier;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const EDGE: u8 = 0x09;
const DEPENDENT: u8 = 0x0A;

/// The value of an edge key: the source it was recorded with and when.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EdgeRecord {
    #[serde(default)]
    pub source_id: Option<String>,
    pub created_at_us: i64,
}

/// One end of an edge: a row's table and its id as text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeRef {
    pub input_table: String,
    pub input_id: String,
}

/// `insertDerivationInputs(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationInputsSpec {
    pub derived_table: String,
    pub derived_id: String,
    #[serde(default)]
    pub source_id: Option<String>,
    pub inputs: Vec<EdgeRef>,
}

/// `listDerivationDependents(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependentsQuery {
    pub frontier: Vec<EdgeRef>,
    pub limit: u64,
}

/// `lowerTrustTier(spec)` on pages.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LowerTierSpec {
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

fn edge_key(derived_table: &str, derived_id: &str, input_table: &str, input_id: &str) -> Vec<u8> {
    let mut key = keys::text(
        keys::TRUST,
        &[derived_table, derived_id, input_table, input_id],
    );
    key.insert(1, EDGE);
    key
}

fn dependent_prefix(input_table: &str, input_id: &str) -> Vec<u8> {
    let mut key = keys::text(keys::TRUST, &[input_table, input_id, ""]);
    key.insert(1, DEPENDENT);
    key
}

fn dependent_key(
    input_table: &str,
    input_id: &str,
    derived_table: &str,
    derived_id: &str,
) -> Vec<u8> {
    let mut key = dependent_prefix(input_table, input_id);
    key.extend_from_slice(derived_table.as_bytes());
    key.push(0);
    key.extend_from_slice(derived_id.as_bytes());
    key
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("derivation edge {what}"))
}

/// Splits the text parts of a key after its two tag bytes.
fn key_parts(key: &[u8], expected: usize) -> Result<Vec<String>> {
    let parts: Vec<String> = key[2..]
        .split(|b| *b == 0)
        .map(|p| String::from_utf8(p.to_vec()).map_err(|_| corrupt("key is not UTF-8")))
        .collect::<Result<_>>()?;
    if parts.len() != expected {
        return Err(corrupt("key is malformed"));
    }
    Ok(parts)
}

/// Removes every edge recorded with a deleted source and its index entry (`ON DELETE CASCADE`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    let mut failure = None;
    scan_prefix(&*tx, &[keys::TRUST, EDGE], false, &mut |k, v| {
        match serde_json::from_slice::<EdgeRecord>(v) {
            Ok(record) if record.source_id.as_deref() == Some(source_id) => doomed.push(k.to_vec()),
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    for key in doomed {
        let parts = key_parts(&key, 4)?;
        tx.delete(&dependent_key(&parts[2], &parts[3], &parts[0], &parts[1]))?;
        tx.delete(&key)?;
    }
    Ok(())
}

/// The derived rows whose edges name an owner-only input, for the owner-only lineage walk
/// (`owner_only`): the inputs of `derived_table`/`derived_id`, as `(input_table, input_id)`.
pub(crate) fn inputs_of(
    read: &dyn KvRead,
    derived_table: &str,
    derived_id: &str,
) -> Result<Vec<(String, String)>> {
    let mut prefix = keys::text(keys::TRUST, &[derived_table, derived_id, ""]);
    prefix.insert(1, EDGE);
    let mut keys_found = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        keys_found.push(k.to_vec());
        true
    })?;
    keys_found
        .iter()
        .map(|k| {
            let parts = key_parts(k, 4)?;
            Ok((parts[2].clone(), parts[3].clone()))
        })
        .collect()
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
    /// `insertDerivationInputs(spec)`: records an edge from the derived row to each input. An edge
    /// already recorded is kept with its source (`ON CONFLICT DO NOTHING`); a source that does not
    /// exist is the table's foreign-key violation.
    pub fn insert_derivation_inputs(&self, spec: &DerivationInputsSpec) -> Result<()> {
        let op = "insertDerivationInputs";
        no_nul(
            op,
            &[
                ("derived_table", spec.derived_table.as_str()),
                ("derived_id", spec.derived_id.as_str()),
                ("source_id", spec.source_id.as_deref().unwrap_or("")),
            ],
        )?;
        for input in &spec.inputs {
            no_nul(
                op,
                &[
                    ("input_table", input.input_table.as_str()),
                    ("input_id", input.input_id.as_str()),
                ],
            )?;
        }
        if spec.inputs.is_empty() {
            return Ok(());
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(source_id) = &spec.source_id {
                require_source(&*tx, source_id).map_err(|_| {
                    StoreError::new(
                        CONSTRAINT_VIOLATION,
                        format!("{op}: source \"{source_id}\" does not exist (derivation_inputs_source_id_fkey)"),
                    )
                })?;
            }
            for input in &spec.inputs {
                let key = edge_key(&spec.derived_table, &spec.derived_id, &input.input_table, &input.input_id);
                if tx.get(&key)?.is_some() {
                    continue;
                }
                let record = EdgeRecord { source_id: spec.source_id.clone(), created_at_us: now };
                put_json(tx, &key, &record)?;
                tx.put(
                    &dependent_key(&input.input_table, &input.input_id, &spec.derived_table, &spec.derived_id),
                    &[],
                )?;
            }
            Ok(())
        })
    }

    /// `listDerivationDependents(spec)`: the distinct rows derived from any frontier row, ordered
    /// by table then id (byte order), at most `limit`.
    pub fn list_derivation_dependents(&self, q: &DependentsQuery) -> Result<Vec<Value>> {
        let op = "listDerivationDependents";
        for f in &q.frontier {
            no_nul(
                op,
                &[
                    ("input_table", f.input_table.as_str()),
                    ("input_id", f.input_id.as_str()),
                ],
            )?;
        }
        let read = self.read()?;
        let mut found: BTreeSet<(String, String)> = BTreeSet::new();
        for f in &q.frontier {
            let prefix = dependent_prefix(&f.input_table, &f.input_id);
            let mut keys_found = Vec::new();
            scan_prefix(&*read, &prefix, false, &mut |k, _| {
                keys_found.push(k[prefix.len()..].to_vec());
                true
            })?;
            for rest in keys_found {
                let mut parts = rest.splitn(2, |b| *b == 0);
                let (Some(table), Some(id)) = (parts.next(), parts.next()) else {
                    return Err(corrupt("index entry is malformed"));
                };
                let text = |b: &[u8]| {
                    String::from_utf8(b.to_vec()).map_err(|_| corrupt("index entry is not UTF-8"))
                };
                found.insert((text(table)?, text(id)?));
            }
        }
        let limit = usize::try_from(q.limit).unwrap_or(usize::MAX);
        Ok(found
            .into_iter()
            .take(limit)
            .map(|(table, id)| json!({ "derived_table": table, "derived_id": id }))
            .collect())
    }

    /// `lowerTrustTier('pages', ids, tier, origin)`: sets `tier` and `origin` on each listed page
    /// whose stored tier ranks above `tier`, deleted or not, and resolves the ids it lowered in id
    /// order. The knowledge revision is kept: the revision trigger reads no trust column.
    pub fn lower_trust_tier(&self, spec: &LowerTierSpec) -> Result<Vec<u64>> {
        let tier = TrustTier::parse(&spec.tier).ok_or_else(|| {
            StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "lowerTrustTier: \"{}\" is not a trust tier (pages_trust_tier_check)",
                    spec.tier
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
        self.write(|tx| {
            let mut lowered = Vec::new();
            for id in ids {
                let Some(page) = read_page_by_id(&*tx, id)? else {
                    continue;
                };
                if TrustTier::stored(page.trust_tier.as_deref()).rank() <= tier.rank() {
                    continue;
                }
                write_page_setting_trust(tx, &page, Some((tier, spec.origin.clone())))?;
                lowered.push(id);
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
            for slug in slugs {
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

/// Reads one edge record (tests).
#[cfg(test)]
fn read_edge(read: &dyn KvRead, d: (&str, &str), i: (&str, &str)) -> Result<Option<EdgeRecord>> {
    crate::get_json(read, &edge_key(d.0, d.1, i.0, i.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store as open_store;

    fn edge(t: &str, id: &str) -> EdgeRef {
        EdgeRef {
            input_table: t.into(),
            input_id: id.into(),
        }
    }

    #[test]
    fn edges_are_idempotent_listed_in_order_and_removed_with_their_source() {
        let store = open_store();
        store
            .insert_derivation_inputs(&DerivationInputsSpec {
                derived_table: "pages".into(),
                derived_id: "7".into(),
                source_id: Some("default".into()),
                inputs: vec![edge("pages", "1"), edge("facts", "2")],
            })
            .unwrap();
        store
            .insert_derivation_inputs(&DerivationInputsSpec {
                derived_table: "facts".into(),
                derived_id: "9".into(),
                source_id: None,
                inputs: vec![edge("pages", "1"), edge("pages", "1")],
            })
            .unwrap();
        let rows = store
            .list_derivation_dependents(&DependentsQuery {
                frontier: vec![edge("pages", "1")],
                limit: 10,
            })
            .unwrap();
        assert_eq!(
            rows,
            vec![
                json!({ "derived_table": "facts", "derived_id": "9" }),
                json!({ "derived_table": "pages", "derived_id": "7" }),
            ]
        );
        let one = store
            .list_derivation_dependents(&DependentsQuery {
                frontier: vec![edge("pages", "1")],
                limit: 1,
            })
            .unwrap();
        assert_eq!(one.len(), 1);
        let read = store.read().unwrap();
        assert!(
            read_edge(&*read, ("pages", "7"), ("facts", "2"))
                .unwrap()
                .is_some()
        );
        assert_eq!(inputs_of(&*read, "pages", "7").unwrap().len(), 2);
        drop(read);
        let err = store
            .insert_derivation_inputs(&DerivationInputsSpec {
                derived_table: "pages".into(),
                derived_id: "8".into(),
                source_id: Some("nope".into()),
                inputs: vec![edge("pages", "1")],
            })
            .unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        store.write(|tx| remove_source_rows(tx, "default")).unwrap();
        let rows = store
            .list_derivation_dependents(&DependentsQuery {
                frontier: vec![edge("pages", "1")],
                limit: 10,
            })
            .unwrap();
        assert_eq!(
            rows,
            vec![json!({ "derived_table": "facts", "derived_id": "9" })]
        );
    }

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
