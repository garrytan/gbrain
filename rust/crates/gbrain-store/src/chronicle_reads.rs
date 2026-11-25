//! The page batch of `chronicle-backfill` (`src/core/chronicle/backfill.ts`), the member
//! `readChronicleBackfillBatch` of `src/core/engine-sql/chronicle-reads.ts`
//! (rust/docs/store/chronicle-reads.md). Carried from 6f801f6d17 (rust-engine/chronicle-reads-rebased
//! c827c0c60c), the batch read only.
//!
//! The SQL reads live pages after a cursor whose type is a chronicle type or whose slug matches a
//! rescue pattern, in the source scope and `since` window, in id order, at most `pageBatch` rows,
//! and flags `done` from the chronicle ledger (`chronicle_page_state`, `chronicle_ledger.rs`): the row at the
//! page's content hash and extractor version is extracted, or is a pending or failed backfill row with attempts left.

use crate::Store;
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages};
use crate::timeline::parse_date;
use serde::Deserialize;
use serde_json::{Value, json};

const OP_BATCH: &str = "readChronicleBackfillBatch";

/// `readChronicleBackfillBatch(q)`: the scope and cursor of one batch.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleBackfillBatchQuery {
    pub types: Vec<String>,
    pub slug_patterns: Vec<String>,
    pub extractor_version: i32,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    pub after_id: i64,
    pub page_batch: usize,
    pub max_attempts: i32,
}

/// `coalesce(p.compiled_truth, p.truth_lead)`.
fn body_or_lead(read: &dyn KvRead, page: &PageRecord) -> Result<Option<String>> {
    match page.compiled_truth.as_deref() {
        Some(text) => Ok(Some(text.to_string())),
        None => crate::page_body::truth_lead(read, page.id),
    }
}

impl Store {
    /// The next batch of chronicle-shaped live pages after `after_id`, in id order.
    pub fn read_chronicle_backfill_batch(&self, q: &ChronicleBackfillBatchQuery) -> Result<Value> {
        // `p.updated_at >= $n::date`: midnight UTC of the date.
        let since_us = match q.since.as_deref() {
            Some(text) => Some(
                parse_iso(&format!("{}T00:00:00Z", parse_date(text)?)).ok_or_else(|| {
                    StoreError::invalid(format!("{OP_BATCH}: since is not a date"))
                })?,
            ),
            None => None,
        };
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.id as i64 > q.after_id)
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::new();
        for page in pages {
            if out.len() >= q.page_batch {
                break;
            }
            let mut shaped = q.types.contains(&page.page_type);
            if !shaped {
                for pattern in &q.slug_patterns {
                    if crate::facts::like(&page.slug, pattern, false)? {
                        shaped = true;
                        break;
                    }
                }
            }
            if !shaped {
                continue;
            }
            let in_scope = match (&q.source_ids, &q.source_id) {
                (Some(ids), _) if !ids.is_empty() => ids.contains(&page.source_id),
                (_, Some(id)) => *id == page.source_id,
                _ => true,
            };
            if !in_scope || since_us.is_some_and(|s| page.updated_at_us < s) {
                continue;
            }
            let done = match page.content_hash.as_deref() {
                Some(hash) => crate::chronicle_ledger::backfill_done(
                    &*read,
                    &page.source_id,
                    page.id as i64,
                    hash,
                    q.extractor_version,
                    q.max_attempts,
                )?,
                None => false,
            };
            out.push(json!({
                "id": page.id,
                "source_id": page.source_id,
                "slug": page.slug,
                "type": page.page_type,
                "compiled_truth": body_or_lead(&*read, &page)?,
                "frontmatter": Value::Object(page.frontmatter.clone()),
                "effective_date": page.effective_date_us.map(iso),
                "effective_date_source": page.effective_date_source,
                "content_hash": page.content_hash,
                "done": done,
            }));
        }
        Ok(Value::Array(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions, read_page};

    fn put(store: &Store, slug: &str, page_type: &str) -> i64 {
        let input = PageInput {
            page_type: page_type.into(),
            title: slug.into(),
            compiled_truth: format!("body of {slug}"),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        read_page(&*store.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
            .id as i64
    }

    fn batch(store: &Store, extra: Value) -> Vec<Value> {
        let mut q = json!({
            "types": ["meeting"], "slugPatterns": ["cal/%"], "extractorVersion": 2, "afterId": 0,
            "pageBatch": 500, "maxAttempts": 5,
        });
        for (k, v) in extra.as_object().unwrap() {
            q[k] = v.clone();
        }
        let q: ChronicleBackfillBatchQuery = serde_json::from_value(q).unwrap();
        match store.read_chronicle_backfill_batch(&q).unwrap() {
            Value::Array(rows) => rows,
            other => panic!("not an array: {other}"),
        }
    }

    fn slugs(rows: &[Value]) -> Vec<&str> {
        rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
    }

    #[test]
    fn the_batch_takes_typed_and_rescued_pages_in_scope_after_the_cursor() {
        let store = crate::test_support::store();
        let m1 = put(&store, "meetings/a", "meeting");
        put(&store, "notes/b", "note");
        put(&store, "cal/c", "note");
        put(&store, "calendar/d", "note");
        assert_eq!(slugs(&batch(&store, json!({}))), ["meetings/a", "cal/c"]);
        assert_eq!(slugs(&batch(&store, json!({ "afterId": m1 }))), ["cal/c"]);
        assert_eq!(
            slugs(&batch(&store, json!({ "pageBatch": 1 }))),
            ["meetings/a"]
        );
        assert!(batch(&store, json!({ "sourceId": "other" })).is_empty());
        assert_eq!(
            batch(
                &store,
                json!({ "sourceIds": ["default"], "sourceId": "other" })
            )
            .len(),
            2
        );
        assert!(batch(&store, json!({ "since": "2999-01-01" })).is_empty());
        assert_eq!(batch(&store, json!({ "since": "2000-01-01" })).len(), 2);
        let first = &batch(&store, json!({}))[0];
        assert_eq!(first["compiled_truth"], json!("body of meetings/a"));
        assert_eq!(first["done"], json!(false));
        store.soft_delete_page("cal/c", None).unwrap();
        assert_eq!(slugs(&batch(&store, json!({}))), ["meetings/a"]);
    }

    #[test]
    fn done_is_an_extracted_row_or_an_open_backfill_with_attempts_left() {
        let store = crate::test_support::store();
        put(&store, "meetings/a", "meeting");
        put(&store, "meetings/b", "meeting");
        put(&store, "meetings/c", "meeting");
        let rows = batch(&store, json!({}));
        let decide = |i: usize, state: &str, trigger: &str| {
            let w: crate::chronicle_ledger::ChronicleRowInput = serde_json::from_value(json!({
                "sourceId": "default", "pageId": rows[i]["id"], "contentHash": rows[i]["content_hash"],
                "extractorVersion": 2, "slug": rows[i]["slug"], "state": state, "trigger": trigger,
            }))
            .unwrap();
            store.upsert_chronicle_row(&w).unwrap();
        };
        decide(0, "pending", "backfill");
        decide(1, "pending", "auto");
        let done: Vec<bool> = batch(&store, json!({}))
            .iter()
            .map(|r| r["done"].as_bool().unwrap())
            .collect();
        // A pending backfill row is done; a pending automatic row and no row are not.
        assert_eq!(done, [true, false, false]);
        // Another extractor version reads no row.
        let other: Vec<bool> = batch(&store, json!({ "extractorVersion": 3 }))
            .iter()
            .map(|r| r["done"].as_bool().unwrap())
            .collect();
        assert_eq!(other, [false, false, false]);
    }
}
