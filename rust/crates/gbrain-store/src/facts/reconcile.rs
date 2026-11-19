//! The facts reconcile watermark: the `page_facts_reconcile` table (schema-migrations/v209).
//!
//! A row records, per page, the `knowledge_revision` the extract_facts phase last reconciled
//! completely and the outcome of its latest attempt. It lives at `F 0x0D page_id` (the table's
//! primary key, 8 bytes big-endian) with the JSON value
//! `{"reconciled_revision": <uuid or null>, "reconciled_at_us": <i64 or null>, "outcome": <text>,
//! "attempted_revision": <uuid or null>, "attempted_at_us": <i64>}`.
//!
//! The store reads the watermark (`listFactsReconcileBacklog`, facts/purge.rs). No member writes it:
//! the extract_facts phase writes it with raw SQL (`settleFactsReconcile` and
//! `selectFactsReconcileDrain` in facts/reconcile-watermark.ts), so on Rust they stop on the typed
//! `raw_sql` refusal and the watermark stays empty, which makes every live page due. A writer that
//! binds here must also delete a page's row when the page row goes (`ON DELETE CASCADE` from
//! `pages`).

use super::source_rows;
use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::all_pages;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

/// `listFactsReconcileBacklog({ marker })`: `marker` is `FACTS_FENCE_BEGIN`, the text the SQL's
/// `LIKE '%' || marker || '%'` looks for (it holds no `%`, `_` or `\`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BacklogArgs {
    pub marker: String,
}

/// The byte after `keys::FACT` that marks a watermark row.
const RECONCILE: u8 = 0x0D;

/// What is stored for a page's watermark.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ReconcileRecord {
    pub reconciled_revision: Option<String>,
    pub reconciled_at_us: Option<i64>,
    pub outcome: String,
    pub attempted_revision: Option<String>,
    pub attempted_at_us: i64,
}

fn key(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::FACT, RECONCILE];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// The watermark of a page, if the extract_facts phase recorded one.
pub(crate) fn read_reconcile(
    read: &dyn KvRead,
    page_id: u64,
    op: &str,
) -> Result<Option<ReconcileRecord>> {
    match read.get(&key(page_id))? {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| StoreError::invalid(format!("{op}: corrupt facts reconcile record: {e}"))),
    }
}

impl Store {
    /// `listFactsReconcileBacklog` (engine-sql/facts-purge.ts). A live page is due when it has no
    /// watermark or its `reconciled_revision` is not its `knowledge_revision`. `rows` are the due
    /// pages whose body or timeline holds `marker` or that own a fence row (a row of the page's source
    /// filed on it with a `row_num`, expired or not), with `invalid` when the latest attempt marked
    /// the current revision invalid, in (source, slug) byte order. `segmented` counts the due
    /// segmented pages (NULL body) that own no fence row.
    pub fn list_facts_reconcile_backlog(&self, a: &BacklogArgs) -> Result<Value> {
        let op = "listFactsReconcileBacklog";
        no_nul(op, &[("marker", &a.marker)])?;
        let read = self.read()?;
        let mut owners: BTreeMap<String, HashSet<String>> = BTreeMap::new();
        let mut due = Vec::new();
        let mut segmented = 0u64;
        for p in all_pages(&*read)? {
            if p.deleted_at_us.is_some() {
                continue;
            }
            let mark = read_reconcile(&*read, p.id, op)?;
            if mark
                .as_ref()
                .is_some_and(|r| r.reconciled_revision.as_deref() == Some(&p.knowledge_revision))
            {
                continue;
            }
            if !owners.contains_key(&p.source_id) {
                let slugs = source_rows(&*read, &p.source_id)?
                    .into_iter()
                    .filter(|f| f.row_num.is_some())
                    .filter_map(|f| f.source_markdown_slug)
                    .collect();
                owners.insert(p.source_id.clone(), slugs);
            }
            let owns = owners[&p.source_id].contains(&p.slug);
            let holds = |t: Option<&str>| t.is_some_and(|t| t.contains(a.marker.as_str()));
            if holds(p.compiled_truth.as_deref()) || holds(p.timeline.as_deref()) || owns {
                let invalid = mark.as_ref().is_some_and(|r| {
                    r.outcome == "invalid"
                        && r.attempted_revision.as_deref() == Some(&p.knowledge_revision)
                });
                due.push((p.source_id, p.slug, invalid));
            } else if p.compiled_truth.is_null() {
                segmented += 1;
            }
        }
        due.sort();
        let rows: Vec<Value> = due
            .into_iter()
            .map(|(source_id, slug, invalid)| json!({ "source_id": source_id, "slug": slug, "invalid": invalid }))
            .collect();
        Ok(json!({ "rows": rows, "segmented": segmented }))
    }
}

/// Writes one watermark row. Only the unit tests call it: no member binds a writer yet (module doc).
#[cfg(test)]
pub(crate) fn put_reconcile(
    tx: &mut dyn crate::kv::KvWrite,
    page_id: u64,
    record: &ReconcileRecord,
) -> Result<()> {
    crate::put_json(tx, &key(page_id), record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::read_page;

    #[test]
    fn a_watermark_at_the_page_revision_settles_it_and_an_invalid_attempt_at_it_marks_it() {
        let store = crate::test_support::store();
        let marker = "<!--- gbrain:facts:begin -->";
        for slug in ["notes/done", "notes/stale", "notes/invalid", "notes/none"] {
            let input: crate::pages::PageInput = serde_json::from_value(json!({
                "type": "note", "title": slug, "compiled_truth": format!("x {marker}"), "frontmatter": {},
            }))
            .unwrap();
            let options: crate::pages::PutPageOptions =
                serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
            store.put_page(slug, &input, &options).unwrap();
        }
        let page = |slug: &str| {
            read_page(&*store.read().unwrap(), "default", slug)
                .unwrap()
                .unwrap()
        };
        let mark = |slug: &str, outcome: &str, reconciled: bool, attempted: bool| {
            let p = page(slug);
            let rev = |current: bool| {
                Some(if current {
                    p.knowledge_revision.clone()
                } else {
                    "older".into()
                })
            };
            store
                .write(|tx| {
                    put_reconcile(
                        tx,
                        p.id,
                        &ReconcileRecord {
                            reconciled_revision: rev(reconciled),
                            reconciled_at_us: Some(0),
                            outcome: outcome.into(),
                            attempted_revision: rev(attempted),
                            attempted_at_us: 0,
                        },
                    )
                })
                .unwrap();
        };
        mark("notes/done", "complete", true, true);
        mark("notes/stale", "complete", false, false);
        mark("notes/invalid", "invalid", false, true);
        let backlog = store
            .list_facts_reconcile_backlog(&BacklogArgs {
                marker: marker.into(),
            })
            .unwrap();
        assert_eq!(
            backlog,
            json!({ "rows": [
                { "source_id": "default", "slug": "notes/invalid", "invalid": true },
                { "source_id": "default", "slug": "notes/none", "invalid": false },
                { "source_id": "default", "slug": "notes/stale", "invalid": false },
            ], "segmented": 0 })
        );
    }
}
