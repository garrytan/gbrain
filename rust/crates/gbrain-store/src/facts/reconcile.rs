//! The facts reconcile watermark: the `page_facts_reconcile` table (schema-migrations/v209).
//!
//! A row records, per page, the `knowledge_revision` the extract_facts phase last reconciled
//! completely and the outcome of its latest attempt. It lives at `F 0x0D page_id` (the table's
//! primary key, 8 bytes big-endian) with the JSON value
//! `{"reconciled_revision": <uuid or null>, "reconciled_at_us": <i64 or null>, "outcome": <text>,
//! "attempted_revision": <uuid or null>, "attempted_at_us": <i64>}`.
//!
//! The store reads the watermark (`listFactsReconcileBacklog`) and writes it for the extract_facts
//! phase (`settleFactsReconcile`, `selectFactsReconcileDrain`; their SQL is in
//! engine-sql/facts-purge.ts). A hard page delete removes the page's row (`remove_page_rows`, the
//! `ON DELETE CASCADE` from `pages`); a soft delete keeps it, as Postgres does. The extract_facts
//! phase settles `complete` inside its write transaction after `lockReconcileRevision` confirms the
//! page is still at the revision it read; on Rust that transaction's single writer is the lock.

use super::source_rows;
use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite};
use crate::links::no_nul;
use crate::pages::{PageRecord, all_pages, read_page};
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

/// `settleFactsReconcile`: `revision` is the `knowledge_revision` the reconcile read, and
/// `anyRevision` is true when the caller passed none (record against the current revision).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettleArgs {
    pub source_id: String,
    pub slug: String,
    pub outcome: String,
    pub revision: Option<String>,
    pub any_revision: bool,
}

/// `lockReconcileRevision`: `revision` is the `knowledge_revision` the reconcile read (null when
/// it read none).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockArgs {
    pub source_id: String,
    pub slug: String,
    pub revision: Option<String>,
}

/// `selectFactsReconcileDrain`: `marker` is `FACTS_FENCE_BEGIN` (plain text, as for the backlog),
/// `settleLimit` bounds the bulk settle of fenceless pages and `pageLimit` the pages returned.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrainArgs {
    pub source_id: String,
    pub marker: String,
    pub settle_limit: u64,
    pub page_limit: u64,
}

/// The outcomes the table's CHECK constraint admits.
const OUTCOMES: [&str; 4] = ["complete", "deferred", "invalid", "cancelled"];

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
            if !is_due(mark.as_ref(), &p) {
                continue;
            }
            if !owners.contains_key(&p.source_id) {
                owners.insert(p.source_id.clone(), fence_owners(&*read, &p.source_id)?);
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

/// Writes one watermark row.
pub(crate) fn put_reconcile(
    tx: &mut dyn KvWrite,
    page_id: u64,
    record: &ReconcileRecord,
) -> Result<()> {
    crate::put_json(tx, &key(page_id), record)
}

/// The page-delete hook (cascade.rs): a hard page delete removes the page's watermark row.
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&key(page.id))
}

/// A live page is due when it has no watermark or one for another revision (`DUE`).
fn is_due(mark: Option<&ReconcileRecord>, page: &PageRecord) -> bool {
    mark.is_none_or(|r| r.reconciled_revision.as_deref() != Some(page.knowledge_revision.as_str()))
}

/// The slugs of `source_id` that own a fence row (`OWNS_FENCE_ROWS`: a row filed on the page with a
/// `row_num`, expired or not).
fn fence_owners(read: &dyn KvRead, source_id: &str) -> Result<HashSet<String>> {
    Ok(source_rows(read, source_id)?
        .into_iter()
        .filter(|f| f.row_num.is_some())
        .filter_map(|f| f.source_markdown_slug)
        .collect())
}

impl Store {
    /// `settleFactsReconcile` (engine-sql/facts-purge.ts): records the outcome of one live page's
    /// attempt at its current revision. Nothing is recorded when the page is gone or deleted, or
    /// when `revision` is given and is not the page's revision. `complete` also moves the reconciled
    /// revision; any other outcome keeps the one stored.
    pub fn settle_facts_reconcile(&self, a: &SettleArgs) -> Result<()> {
        let op = "settleFactsReconcile";
        no_nul(
            op,
            &[
                ("sourceId", &a.source_id),
                ("slug", &a.slug),
                ("outcome", &a.outcome),
            ],
        )?;
        if !OUTCOMES.contains(&a.outcome.as_str()) {
            return Err(StoreError::invalid(format!(
                "{op}: outcome {:?} is not one of complete, deferred, invalid, cancelled",
                a.outcome
            )));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(page) = read_page(&*tx, &a.source_id, &a.slug)? else {
                return Ok(());
            };
            if page.deleted_at_us.is_some()
                || (!a.any_revision
                    && a.revision.as_deref() != Some(page.knowledge_revision.as_str()))
            {
                return Ok(());
            }
            let old = read_reconcile(&*tx, page.id, op)?;
            let complete = a.outcome == "complete";
            let record = ReconcileRecord {
                reconciled_revision: if complete {
                    Some(page.knowledge_revision.clone())
                } else {
                    old.as_ref().and_then(|r| r.reconciled_revision.clone())
                },
                reconciled_at_us: if complete {
                    Some(now)
                } else {
                    old.as_ref().and_then(|r| r.reconciled_at_us)
                },
                outcome: a.outcome.clone(),
                attempted_revision: Some(page.knowledge_revision.clone()),
                attempted_at_us: now,
            };
            put_reconcile(tx, page.id, &record)
        })
    }

    /// `lockReconcileRevision`: true when the live page `(sourceId, slug)` is at `revision`.
    /// Postgres takes a `FOR SHARE` row lock for the rest of the transaction. On a store bound to a
    /// transaction the read runs inside it and sees its own writes; that transaction holds the
    /// store's single writer from begin to commit, so no other writer changes the page before the
    /// caller's settle commits, which is the lock. A plain read is not blocked, as on Postgres.
    /// Outside a transaction it reads the last commit, as Postgres' lock ends with its statement.
    pub fn lock_reconcile_revision(&self, a: &LockArgs) -> Result<bool> {
        no_nul(
            "lockReconcileRevision",
            &[("sourceId", &a.source_id), ("slug", &a.slug)],
        )?;
        let read = self.read()?;
        Ok(match read_page(&*read, &a.source_id, &a.slug)? {
            Some(page) if page.deleted_at_us.is_none() => {
                a.revision.as_deref() == Some(page.knowledge_revision.as_str())
            }
            _ => false,
        })
    }

    /// `selectFactsReconcileDrain` (engine-sql/facts-purge.ts). First settles `complete`, at most
    /// `settleLimit` in id order, the due live pages of the source whose body and timeline hold no
    /// `marker` and that own no fence row (a segmented page, NULL body, is never settled here). Then
    /// returns the slugs of the due live pages not marked invalid at their current revision,
    /// never-attempted first, then by oldest attempt, then by id, at most `pageLimit`.
    pub fn select_facts_reconcile_drain(&self, a: &DrainArgs) -> Result<Vec<String>> {
        let op = "selectFactsReconcileDrain";
        no_nul(op, &[("sourceId", &a.source_id), ("marker", &a.marker)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut pages: Vec<PageRecord> = all_pages(&*tx)?
                .into_iter()
                .filter(|p| p.source_id == a.source_id && p.deleted_at_us.is_none())
                .collect();
            pages.sort_by_key(|p| p.id);
            let owners = fence_owners(&*tx, &a.source_id)?;
            let lacks = |t: Option<&str>| t.is_some_and(|t| !t.contains(a.marker.as_str()));
            let mut settled = 0u64;
            for p in &pages {
                if settled >= a.settle_limit {
                    break;
                }
                let mark = read_reconcile(&*tx, p.id, op)?;
                if !is_due(mark.as_ref(), p)
                    || !lacks(p.compiled_truth.as_deref())
                    || !lacks(p.timeline.as_deref())
                    || owners.contains(&p.slug)
                {
                    continue;
                }
                let revision = Some(p.knowledge_revision.clone());
                put_reconcile(
                    tx,
                    p.id,
                    &ReconcileRecord {
                        reconciled_revision: revision.clone(),
                        reconciled_at_us: Some(now),
                        outcome: "complete".into(),
                        attempted_revision: revision,
                        attempted_at_us: now,
                    },
                )?;
                settled += 1;
            }
            let mut drain = Vec::new();
            for p in pages {
                let mark = read_reconcile(&*tx, p.id, op)?;
                let invalid_now = mark.as_ref().is_some_and(|r| {
                    r.outcome == "invalid"
                        && r.attempted_revision.as_deref() == Some(p.knowledge_revision.as_str())
                });
                if is_due(mark.as_ref(), &p) && !invalid_now {
                    let attempted = mark.map(|r| r.attempted_at_us);
                    drain.push((attempted.is_some(), attempted, p.id, p.slug));
                }
            }
            drain.sort();
            let limit = usize::try_from(a.page_limit).unwrap_or(usize::MAX);
            Ok(drain
                .into_iter()
                .take(limit)
                .map(|(.., slug)| slug)
                .collect())
        })
    }
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

    fn put(store: &crate::Store, slug: &str, body: &str) -> crate::pages::PageRecord {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": body, "frontmatter": {},
        }))
        .unwrap();
        let options: crate::pages::PutPageOptions =
            serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
        store.put_page(slug, &input, &options).unwrap();
        read_page(&*store.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
    }

    fn settle(store: &crate::Store, slug: &str, outcome: &str, revision: Option<Option<&str>>) {
        store
            .settle_facts_reconcile(&SettleArgs {
                source_id: "default".into(),
                slug: slug.into(),
                outcome: outcome.into(),
                revision: revision.flatten().map(str::to_string),
                any_revision: revision.is_none(),
            })
            .unwrap();
    }

    fn locked(store: &crate::Store, source_id: &str, slug: &str, revision: Option<&str>) -> bool {
        store
            .lock_reconcile_revision(&LockArgs {
                source_id: source_id.into(),
                slug: slug.into(),
                revision: revision.map(str::to_string),
            })
            .unwrap()
    }

    #[test]
    fn the_lock_answers_true_only_for_the_live_page_at_the_read_revision_and_sees_its_transaction()
    {
        let store = crate::test_support::store();
        let page = put(&store, "notes/live", "x");
        let gone = put(&store, "notes/gone", "x");
        store.soft_delete_page("notes/gone", None).unwrap();
        let rev = page.knowledge_revision.as_str();
        assert!(locked(&store, "default", "notes/live", Some(rev)));
        assert!(!locked(
            &store,
            "default",
            "notes/live",
            Some("00000000-0000-4000-8000-000000000000")
        ));
        assert!(!locked(&store, "default", "notes/live", None));
        assert!(!locked(
            &store,
            "default",
            "notes/gone",
            Some(gone.knowledge_revision.as_str())
        ));
        assert!(!locked(&store, "other", "notes/live", Some(rev)));
        assert!(!locked(&store, "default", "notes/missing", Some(rev)));
        assert!(
            store
                .lock_reconcile_revision(&LockArgs {
                    source_id: "default".into(),
                    slug: "notes/\0live".into(),
                    revision: Some(rev.into()),
                })
                .is_err()
        );
    }

    #[test]
    fn a_hard_page_delete_removes_the_watermark_and_a_soft_delete_keeps_it() {
        let store = crate::test_support::store();
        let hard = put(&store, "notes/hard", "x");
        let soft = put(&store, "notes/soft", "x");
        settle(&store, "notes/hard", "complete", None);
        settle(&store, "notes/soft", "complete", None);
        store.soft_delete_page("notes/soft", None).unwrap();
        store.delete_page("notes/hard", None).unwrap();
        let read = store.read().unwrap();
        assert!(read_reconcile(&*read, hard.id, "t").unwrap().is_none());
        assert!(read_reconcile(&*read, soft.id, "t").unwrap().is_some());
    }

    #[test]
    fn a_settle_records_only_at_the_read_revision_and_keeps_the_reconciled_one() {
        let store = crate::test_support::store();
        let p = put(&store, "notes/a", "x");
        let rev = p.knowledge_revision.clone();
        settle(
            &store,
            "notes/a",
            "complete",
            Some(Some("00000000-0000-4000-8000-000000000000")),
        );
        assert!(
            read_reconcile(&*store.read().unwrap(), p.id, "t")
                .unwrap()
                .is_none()
        );
        settle(&store, "notes/a", "complete", Some(Some(&rev)));
        settle(&store, "notes/a", "deferred", None);
        let mark = read_reconcile(&*store.read().unwrap(), p.id, "t")
            .unwrap()
            .unwrap();
        assert_eq!(mark.reconciled_revision.as_deref(), Some(rev.as_str()));
        assert_eq!(mark.outcome, "deferred");
        assert!(
            store
                .settle_facts_reconcile(&SettleArgs {
                    source_id: "default".into(),
                    slug: "notes/a".into(),
                    outcome: "done".into(),
                    revision: None,
                    any_revision: true,
                })
                .is_err()
        );
    }

    #[test]
    fn the_drain_settles_fenceless_pages_and_lists_the_rest_never_attempted_first() {
        let store = crate::test_support::store();
        let marker = "<!--- gbrain:facts:begin -->";
        put(&store, "notes/plain", "no fence");
        put(&store, "notes/fenced", &format!("x {marker}"));
        put(&store, "notes/tried", &format!("x {marker}"));
        put(&store, "notes/bad", &format!("x {marker}"));
        settle(&store, "notes/tried", "deferred", None);
        settle(&store, "notes/bad", "invalid", None);
        let drain = store
            .select_facts_reconcile_drain(&DrainArgs {
                source_id: "default".into(),
                marker: marker.into(),
                settle_limit: 10,
                page_limit: 10,
            })
            .unwrap();
        assert_eq!(
            drain,
            vec!["notes/fenced".to_string(), "notes/tried".to_string()]
        );
        let plain = read_page(&*store.read().unwrap(), "default", "notes/plain")
            .unwrap()
            .unwrap();
        let mark = read_reconcile(&*store.read().unwrap(), plain.id, "t")
            .unwrap()
            .unwrap();
        assert_eq!(mark.outcome, "complete");
    }
}
