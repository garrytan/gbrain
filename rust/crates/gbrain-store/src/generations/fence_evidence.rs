//! The ledger and version reads of `src/core/generations/fence-evidence.ts` (#8819: whether a
//! page's `## Facts` fence ever held a fact row) over the rows of the parent module and the page
//! version records (`pages.rs`).
//!
//! Members: listRecordedFenceItemKeys, hasBodylessPageVersion and listFenceVersionBodies (the
//! read statements of `engine-sql/generation-fence-evidence.ts`). The fact row move of the same
//! file is `facts/kept_rows.rs`. These are internal evidence reads of one page, not caller page
//! reads, so they take no page read policy. They add no keys.
//!
//! The version reads find the page by its exact `(source_id, slug)` key, deleted or not, as the
//! SQL join on `pages` does, and read its `V page_id version` records.

use super::{GenerationKey, GenerationRecord, ItemRecord, RECORD, check_key, int8, item_key};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::{VersionRecord, read_page};
use crate::{Store, keys};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The facts fence marker the version batch read looks for (`strpos(..., 'gbrain:facts:') > 0`).
const FACTS_MARKER: &str = "gbrain:facts:";

/// The version records of page `slug` of `source_id`, in id order; none when no page has the key.
pub(super) fn page_versions(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Vec<VersionRecord>> {
    let Some(page) = read_page(read, source_id, slug)? else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::version_prefix(page.id), false, &mut |_, v| {
        match serde_json::from_slice::<VersionRecord>(v) {
            Ok(row) => rows.push(row),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(rows), Err)
}

impl Store {
    /// `listRecordedFenceItemKeys(key, itemKeys)`: the keys of `item_keys` that an item of a
    /// generation of `key` in any state but `held` records with an action other than `retired`,
    /// as `{ item_key }`, each once, in key order (Postgres's `DISTINCT` gives no order).
    pub fn list_recorded_fence_item_keys(
        &self,
        key: &GenerationKey,
        item_keys: &[String],
    ) -> Result<Vec<Value>> {
        const OP: &str = "listRecordedFenceItemKeys";
        check_key(OP, key)?;
        for text in item_keys {
            no_nul(OP, &[("itemKeys", text.as_str())])?;
        }
        let wanted: BTreeSet<&str> = item_keys.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut generations = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &[keys::DERIVED_GENERATION, RECORD],
            false,
            &mut |_, v| {
                match serde_json::from_slice::<GenerationRecord>(v) {
                    Ok(record)
                        if record.source_id == key.source_id
                            && record.kind == key.kind
                            && record.owner_key == key.owner_key
                            && record.state != "held" =>
                    {
                        generations.push(record.id);
                    }
                    Ok(_) => {}
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none()
            },
        )?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut found = BTreeSet::new();
        for id in generations {
            for wanted_key in &wanted {
                if let Some(bytes) = read.get(&item_key(id, wanted_key))? {
                    let record: ItemRecord = serde_json::from_slice(&bytes)?;
                    if record.action != "retired" {
                        found.insert(*wanted_key);
                    }
                }
            }
        }
        Ok(found
            .into_iter()
            .map(|found_key| json!({ "item_key": found_key }))
            .collect())
    }

    /// `hasBodylessPageVersion(sourceId, slug)`: whether a stored version of the page has a NULL
    /// `compiled_truth` (a segmented page's snapshot).
    pub fn has_bodyless_page_version(&self, source_id: &str, slug: &str) -> Result<bool> {
        no_nul(
            "hasBodylessPageVersion",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(page_versions(&*read, source_id, slug)?
            .iter()
            .any(|row| row.compiled_truth.is_null()))
    }

    /// `listFenceVersionBodies(sourceId, slug, before, limit)`: up to `limit` stored versions of
    /// the page with a body, below id `before` when given, whose body or timeline holds a facts
    /// fence marker, as `{ id, compiled_truth, timeline }`, newest first.
    pub fn list_fence_version_bodies(
        &self,
        source_id: &str,
        slug: &str,
        before: Option<f64>,
        limit: f64,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listFenceVersionBodies";
        no_nul(OP, &[("sourceId", source_id), ("slug", slug)])?;
        let before = before.map(|id| int8(OP, "before", id)).transpose()?;
        let limit = int8(OP, "limit", limit)?;
        if limit < 0 {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP}: LIMIT must not be negative"),
            ));
        }
        let read = self.read()?;
        let mut rows: Vec<VersionRecord> = page_versions(&*read, source_id, slug)?
            .into_iter()
            .filter(|row| {
                let Some(body) = row.compiled_truth.as_deref() else {
                    return false;
                };
                before.is_none_or(|before| i64::try_from(row.id).is_ok_and(|id| id < before))
                    && (body.contains(FACTS_MARKER)
                        || row
                            .timeline
                            .as_deref()
                            .is_some_and(|timeline| timeline.contains(FACTS_MARKER)))
            })
            .collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.id));
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(rows
            .iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "compiled_truth": row.compiled_truth.as_deref(),
                    "timeline": row.timeline.as_deref(),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generations::{ActivationInput, HeldInput, LedgerItemInput};
    use crate::test_support::store;

    fn key(owner: &str) -> GenerationKey {
        GenerationKey {
            source_id: "default".into(),
            kind: "fact_fence".into(),
            owner_key: owner.into(),
        }
    }

    fn item(item_key: &str, action: &str) -> LedgerItemInput {
        LedgerItemInput {
            item_key: item_key.into(),
            identity_hash: "id".into(),
            action: action.into(),
            preimage: None,
            preimage_bytes: None,
            pending: false,
        }
    }

    fn activate(store: &Store, owner: &str, live: Option<f64>, items: &[LedgerItemInput]) -> f64 {
        store
            .activate_generation_rows(
                &key(owner),
                live,
                &ActivationInput {
                    generation: if live.is_some() { 2.0 } else { 1.0 },
                    run_id: None,
                    operation_id: format!("op-{owner}-{live:?}"),
                    input_pin: None,
                    input_size: None,
                    completeness: "{}".into(),
                    set_hash: "h".into(),
                    restore_of: None,
                    activation_id: None,
                    locator: None,
                },
                items,
            )
            .unwrap() as f64
    }

    #[test]
    fn recorded_keys_skip_held_rows_retired_items_and_other_keys() {
        let store = store();
        let first = activate(
            &store,
            "page:a",
            None,
            &[item("r1", "published"), item("r2", "published")],
        );
        activate(
            &store,
            "page:a",
            Some(first),
            &[item("r2", "retired"), item("r3", "kept")],
        );
        activate(&store, "page:b", None, &[item("r4", "published")]);
        store
            .record_held_generation_row(
                &key("page:a"),
                &HeldInput {
                    hold_id: "hold".into(),
                    run_id: None,
                    input_pin: None,
                    input_size: None,
                    set_hash: "h".into(),
                    reason: "shrunk".into(),
                    context: "{}".into(),
                    proposal: None,
                    proposal_bytes: 0.0,
                },
            )
            .unwrap();
        let wanted: Vec<String> = ["r3", "r2", "r1", "r4", "r9"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let rows = store
            .list_recorded_fence_item_keys(&key("page:a"), &wanted)
            .unwrap();
        // r2 is retired by the live generation but published by the superseded one.
        assert_eq!(
            rows,
            vec![
                json!({ "item_key": "r1" }),
                json!({ "item_key": "r2" }),
                json!({ "item_key": "r3" }),
            ]
        );
    }

    #[test]
    fn version_reads_of_a_missing_page_are_empty_and_a_negative_limit_refuses() {
        let store = store();
        assert!(!store.has_bodyless_page_version("default", "nope").unwrap());
        assert!(
            store
                .list_fence_version_bodies("default", "nope", None, 50.0)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_fence_version_bodies("default", "nope", None, -1.0)
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }
}
