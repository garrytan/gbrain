//! A managed sync pass's `I⋈P` (`readSyncImportPageRows`, `src/core/engine-sql/sync-pass-pages.ts`): every page of a
//! source with a recorded origin, joined with the fields of its sync import provenance record (`op_checkpoints`, op
//! `sync-import-provenance`, fingerprint `<source>:<incarnation>:<page id>`) that the pass's classifier reads, for a
//! window of page ids or a keyset page, in page id order (rust/docs/store/persistence.md, "Sync pass pages").
//!
//! Each column answers as the SQL statement does:
//! - `->>` gives a string as is, a JSON null or a missing key as NULL, anything else as its jsonb text; `->` keeps a
//!   JSON null (a jsonb `null`, not SQL NULL), so `(->'working')::text` of a JSON null is `"null"`.
//! - `rec_parser` / `rec_parser_expected` compare as jsonb: object keys in any order, numbers by value.
//! - `derived_current` is three-valued: a NULL `chunker_version` leaves it NULL unless another term is false.
//! - `sync_deleted` is false for a live page; for a deleted one it is the open tombstone record
//!   (`sync-delete-tombstone`, fingerprint the page id, `deleted_at` equal to the page's) or an uncompacted committed
//!   `managed_sync_delete` request of the page that completed at or after its `deleted_at`.
//!
//! Postgres's whole-source cursor (`declareSyncImportPageCursor` / `fetchSyncImportPageCursor`) has no store form.

use std::collections::{HashMap, HashSet};

use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::parent_key;
use super::projection_queue::parse_timestamptz;
use super::{all_requests, and3, extra_bool};
use crate::cli_reads::pg_text::jsonb_text;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages};
use crate::{Store, get_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// `SYNC_IMPORT_PROVENANCE_OP` (persistence/sync-holds.ts).
const SYNC_IMPORT_PROVENANCE_OP: &str = "sync-import-provenance";
/// `SYNC_DELETE_TOMBSTONE_OP` (persistence/sync-delete-tombstones.ts).
const SYNC_DELETE_TOMBSTONE_OP: &str = "sync-delete-tombstone";

/// `SyncImportPageQuery`, plus the Markdown chunker version the statement embeds (`MARKDOWN_CHUNKER_VERSION`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncImportPageQuery {
    pub source_id: String,
    pub incarnation: String,
    pub expected: Value,
    pub chunker_version: i64,
}

/// `SyncImportPageWindow`: the named page ids (`p.id = ANY($5::bigint[])`), or the `limit` pages after `after`.
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum SyncImportPageWindow {
    Ids { ids: Vec<String> },
    After { after: i64, limit: u64 },
}

/// JavaScript's `Number.MAX_SAFE_INTEGER`, the largest page size the SQL builder accepts.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// jsonb `=`: object keys in any order, numbers by value.
fn jsonb_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_i64(), y.as_i64()) {
            (Some(x), Some(y)) => x == y,
            _ => match (x.as_u64(), y.as_u64()) {
                (Some(x), Some(y)) => x == y,
                _ => x.as_f64() == y.as_f64(),
            },
        },
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| jsonb_equal(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| jsonb_equal(v, w)))
        }
        _ => a == b,
    }
}

/// The `I⋈P` record subquery's columns of one page's record (`completed_keys->0`).
struct Record {
    origin: Option<String>,
    blob_oid: Option<String>,
    disk_blob_oid: Option<String>,
    revision: Option<String>,
    parser: Option<Value>,
    full_episode: Option<String>,
    working: Option<String>,
}

impl Record {
    fn of(row: &HousekeepingRow) -> Self {
        // `completed_keys->0`: the first element of an array; SQL NULL for an empty array or any other value.
        let first = row.completed_keys.as_array().and_then(|keys| keys.first());
        let field = |name: &str| first.and_then(|v| v.as_object()).and_then(|o| o.get(name));
        Self {
            origin: arrow_text(field("origin")),
            blob_oid: arrow_text(field("blob_oid")),
            disk_blob_oid: arrow_text(field("disk_blob_oid")),
            revision: arrow_text(field("revision")),
            parser: field("parser").cloned(),
            full_episode: arrow_text(field("full_episode")),
            working: field("working").map(jsonb_text),
        }
    }
}

/// `->>`: a string as is, a JSON null or a missing key as SQL NULL, anything else as its jsonb text.
fn arrow_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// The latest completion of each page's uncompacted committed `managed_sync_delete` request, by (source, slug, page id).
fn sync_delete_completions(read: &dyn KvRead) -> Result<HashMap<(String, String, u64), i64>> {
    let mut out: HashMap<(String, String, u64), i64> = HashMap::new();
    for r in all_requests(read)? {
        let (Some(page_id), Some(completed)) = (r.page_id, r.completed_at_us) else {
            continue;
        };
        if r.intent.is_null()
            || extra_bool(&r, "compacted")
            || r.state != "committed"
            || arrow_text(r.intent.get("kind")).as_deref() != Some("managed_sync_delete")
        {
            continue;
        }
        let at = out
            .entry((r.source_id.clone(), r.slug.clone(), page_id))
            .or_insert(completed);
        *at = (*at).max(completed);
    }
    Ok(out)
}

/// `syncDeleteOrigin('p')` of a deleted page.
fn sync_delete_origin(
    read: &dyn KvRead,
    page: &PageRecord,
    deleted_at: i64,
    completions: &HashMap<(String, String, u64), i64>,
) -> Result<bool> {
    let key = parent_key(SYNC_DELETE_TOMBSTONE_OP, &page.id.to_string())?;
    if let Some(row) = get_json::<HousekeepingRow>(read, &key)? {
        let first = row.completed_keys.as_array().and_then(|keys| keys.first());
        let stamped = arrow_text(
            first
                .and_then(|v| v.as_object())
                .and_then(|o| o.get("deleted_at")),
        );
        if let Some(text) = stamped
            && parse_timestamptz(&text, "a sync delete tombstone's deleted_at")? == deleted_at
        {
            return Ok(true);
        }
    }
    Ok(completions
        .get(&(page.source_id.clone(), page.slug.clone(), page.id))
        .is_some_and(|completed| *completed >= deleted_at))
}

/// `readSyncImportPageRows(q, window)`.
pub(crate) fn read_sync_import_page_rows_in(
    read: &dyn KvRead,
    q: &SyncImportPageQuery,
    window: &SyncImportPageWindow,
) -> Result<Value> {
    // SQL's syncImportPagesSql refuses a page size that is not a positive safe integer; a size napi could not read as
    // a u64 (negative, fractional) never gets here.
    if let SyncImportPageWindow::After { limit, .. } = window
        && (*limit == 0 || *limit > MAX_SAFE_INTEGER)
    {
        return Err(StoreError::invalid(format!(
            "readSyncImportPageRows: limit must be a positive integer, got {limit}"
        )));
    }
    let ids: Option<HashSet<i64>> = match window {
        SyncImportPageWindow::Ids { ids } => Some(
            ids.iter()
                .map(|id| {
                    id.trim().parse::<i64>().map_err(|_| {
                        StoreError::invalid(format!("invalid input syntax for type bigint: {id:?}"))
                    })
                })
                .collect::<Result<_>>()?,
        ),
        SyncImportPageWindow::After { .. } => None,
    };
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| p.source_id == q.source_id && p.source_path.is_some())
        .filter(|p| match (window, &ids) {
            (_, Some(ids)) => ids.contains(&(p.id as i64)),
            (SyncImportPageWindow::After { after, .. }, None) => (p.id as i64) > *after,
            _ => false,
        })
        .collect();
    pages.sort_by_key(|p| p.id);
    if let SyncImportPageWindow::After { limit, .. } = window {
        pages.truncate(usize::try_from(*limit).unwrap_or(usize::MAX));
    }
    let prefix = format!("{}:{}:", q.source_id, q.incarnation);
    let mut completions = None;
    let mut rows = Vec::with_capacity(pages.len());
    for page in &pages {
        let source_path = page.source_path.clone().unwrap_or_default();
        let revision = page.knowledge_revision.clone();
        let record = get_json::<HousekeepingRow>(
            read,
            &parent_key(SYNC_IMPORT_PROVENANCE_OP, &format!("{prefix}{}", page.id))?,
        )?
        .map(|row| Record::of(&row));
        let rec = record.as_ref();
        let origin = rec.and_then(|r| r.origin.clone());
        let blob = rec.and_then(|r| r.blob_oid.clone());
        let disk = rec.and_then(|r| r.disk_blob_oid.clone());
        let rec_revision = rec.and_then(|r| r.revision.clone());
        let parser = rec.and_then(|r| r.parser.as_ref());
        let storage = crate::page_body::read_body_state(read, page.id)?
            .map_or_else(|| "inline".to_string(), |s| s.body_storage);
        let mode = crate::aliases::contextual_retrieval_mode(read, page.id)?;
        let derived_current = [
            Some(page.page_kind == "markdown"),
            page.chunker_version
                .map(|v| i64::from(v) == q.chunker_version),
            Some(storage != "segmented"),
            Some(page.text_projection_revision.as_deref() == Some(revision.as_str())),
            Some(mode.is_some()),
        ]
        .into_iter()
        .fold(Some(true), and3);
        let sync_deleted = match page.deleted_at_us {
            None => false,
            Some(deleted_at) => {
                if completions.is_none() {
                    completions = Some(sync_delete_completions(read)?);
                }
                sync_delete_origin(read, page, deleted_at, completions.as_ref().unwrap())?
            }
        };
        let mut row = Map::new();
        row.insert("id".into(), json!(page.id));
        row.insert("slug".into(), json!(page.slug));
        row.insert("source_path".into(), json!(source_path));
        row.insert("revision".into(), json!(revision));
        row.insert("deleted".into(), json!(page.deleted_at_us.is_some()));
        row.insert("request_id".into(), json!(page.revision_receipt.request_id));
        row.insert("has_record".into(), json!(record.is_some()));
        row.insert(
            "rec_origin_same".into(),
            json!(origin.as_deref() == Some(source_path.as_str())),
        );
        row.insert(
            "rec_origin".into(),
            json!(origin.filter(|o| *o != source_path)),
        );
        row.insert("rec_blob_oid".into(), json!(blob));
        row.insert("rec_disk_same".into(), json!(disk == blob));
        row.insert(
            "rec_disk_blob_oid".into(),
            json!(if disk == blob { None } else { disk }),
        );
        row.insert("rec_revision_null".into(), json!(rec_revision.is_none()));
        row.insert(
            "rec_revision".into(),
            json!(rec_revision.filter(|r| *r != revision)),
        );
        row.insert(
            "rec_parser".into(),
            json!(
                parser
                    .filter(|p| !jsonb_equal(p, &q.expected))
                    .map(jsonb_text)
            ),
        );
        row.insert(
            "rec_parser_expected".into(),
            json!(parser.map(|p| jsonb_equal(p, &q.expected))),
        );
        row.insert(
            "rec_full_episode".into(),
            json!(rec.and_then(|r| r.full_episode.clone())),
        );
        row.insert(
            "rec_working".into(),
            json!(rec.and_then(|r| r.working.clone())),
        );
        row.insert("derived_current".into(), json!(derived_current));
        row.insert("sync_deleted".into(), json!(sync_deleted));
        rows.push(Value::Object(row));
    }
    Ok(Value::Array(rows))
}

impl Store {
    /// `readSyncImportPageRows(q, window)`.
    pub fn read_sync_import_page_rows(
        &self,
        q: &SyncImportPageQuery,
        window: &SyncImportPageWindow,
    ) -> Result<Value> {
        read_sync_import_page_rows_in(&*self.read()?, q, window)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::iso;
    use crate::pages::{PageInput, PutPageOptions, read_page, write_page};
    use crate::test_support::store;
    use crate::{keys, put_json};

    fn put(store: &Store, slug: &str) -> PageRecord {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: format!("{slug} body"),
            source_path: Some(format!("{slug}.md")),
            ..Default::default()
        };
        let options = PutPageOptions {
            index: Some(false),
            ..Default::default()
        };
        store.put_page(slug, &input, &options).unwrap();
        page(store, slug)
    }

    fn page(store: &Store, slug: &str) -> PageRecord {
        read_page(&*store.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
    }

    fn query(expected: Value) -> SyncImportPageQuery {
        SyncImportPageQuery {
            source_id: "default".into(),
            incarnation: "inc-1".into(),
            expected,
            chunker_version: 4,
        }
    }

    fn rows(store: &Store, q: &SyncImportPageQuery) -> Vec<Value> {
        let window = SyncImportPageWindow::After {
            after: 0,
            limit: 100,
        };
        let rows = store.read_sync_import_page_rows(q, &window).unwrap();
        rows.as_array().unwrap().clone()
    }

    #[test]
    fn a_record_that_repeats_the_page_folds_to_flags_and_parsers_compare_as_jsonb() {
        let store = store();
        let a = put(&store, "notes/a");
        let record = json!({ "origin": "notes/a.md", "blob_oid": "b", "disk_blob_oid": "b",
            "revision": a.knowledge_revision, "parser": { "v": 1, "k": [1, "x"] }, "full_episode": 7, "working": null });
        store
            .write_op_checkpoint_records(
                SYNC_IMPORT_PROVENANCE_OP,
                &[(format!("default:inc-1:{}", a.id), record)],
            )
            .unwrap();
        let row = &rows(&store, &query(json!({ "k": [1, "x"], "v": 1.0 })))[0];
        assert_eq!(row["has_record"], json!(true));
        assert_eq!(row["rec_origin_same"], json!(true));
        assert_eq!(row["rec_origin"], Value::Null);
        assert_eq!(row["rec_disk_same"], json!(true));
        assert_eq!(row["rec_revision_null"], json!(false));
        assert_eq!(row["rec_revision"], Value::Null);
        assert_eq!(row["rec_parser_expected"], json!(true));
        assert_eq!(row["rec_parser"], Value::Null);
        assert_eq!(row["rec_full_episode"], json!("7"));
        assert_eq!(row["rec_working"], json!("null"));
        // Another parser comes back as its jsonb text.
        let row = &rows(&store, &query(json!({ "v": 2 })))[0];
        assert_eq!(row["rec_parser_expected"], json!(false));
        assert_eq!(row["rec_parser"], json!(r#"{"k": [1, "x"], "v": 1}"#));
    }

    #[test]
    fn a_deleted_page_is_a_sync_deletion_only_with_its_tombstone_or_an_uncompacted_receipt() {
        let store = store();
        put(&store, "notes/gone");
        store.soft_delete_page("notes/gone", None).unwrap();
        let gone = page(&store, "notes/gone");
        let deleted_at = gone.deleted_at_us.unwrap();
        let q = query(json!({}));
        assert_eq!(rows(&store, &q)[0]["sync_deleted"], json!(false));
        // The tombstone of the same deletion; one of another time is not.
        let tombstone = |at: i64| {
            store
                .write_op_checkpoint_records(
                    SYNC_DELETE_TOMBSTONE_OP,
                    &[(gone.id.to_string(), json!({ "deleted_at": iso(at) }))],
                )
                .unwrap();
        };
        tombstone(deleted_at - 1);
        assert_eq!(rows(&store, &q)[0]["sync_deleted"], json!(false));
        tombstone(deleted_at);
        assert_eq!(rows(&store, &q)[0]["sync_deleted"], json!(true));
        store
            .delete_op_checkpoint(SYNC_DELETE_TOMBSTONE_OP, &gone.id.to_string())
            .unwrap();
        // The committed managed_sync_delete receipt that deleted it, until it is compacted.
        let receipt = |compacted: bool| {
            let record = json!({ "id": "r1", "principal_kind": "local", "principal_id": "cli", "request_id": "r1",
                "operation": "sync", "source_id": "default", "source_incarnation": "inc-1", "page_id": gone.id,
                "slug": "notes/gone", "digest": "d", "intent": { "kind": "managed_sync_delete" }, "authority": {},
                "sequence": 1, "state": "committed", "created_at_us": deleted_at, "updated_at_us": deleted_at,
                "completed_at_us": deleted_at, "compacted": compacted });
            store
                .write(|tx| put_json(tx, &keys::request("r1"), &record))
                .unwrap();
        };
        receipt(false);
        assert_eq!(rows(&store, &q)[0]["sync_deleted"], json!(true));
        receipt(true);
        assert_eq!(rows(&store, &q)[0]["sync_deleted"], json!(false));
    }

    #[test]
    fn a_keyset_page_size_of_zero_or_past_the_safe_integer_range_is_refused() {
        let store = store();
        put(&store, "notes/a");
        let q = query(json!({}));
        for limit in [0, MAX_SAFE_INTEGER + 1] {
            let window = SyncImportPageWindow::After { after: 0, limit };
            let err = store.read_sync_import_page_rows(&q, &window).unwrap_err();
            assert_eq!(err.code, crate::error::INVALID_ARGUMENT, "limit {limit}");
            assert!(
                err.message.contains("limit must be a positive integer"),
                "limit {limit}: {}",
                err.message
            );
        }
        let window = SyncImportPageWindow::After {
            after: 0,
            limit: MAX_SAFE_INTEGER,
        };
        assert_eq!(rows_of(&store, &q, &window).len(), 1);
    }

    fn rows_of(
        store: &Store,
        q: &SyncImportPageQuery,
        window: &SyncImportPageWindow,
    ) -> Vec<Value> {
        store
            .read_sync_import_page_rows(q, window)
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }

    #[test]
    fn derived_current_is_true_only_when_every_projection_term_is_current() {
        let store = store();
        let q = query(json!({}));
        // An all-current page: markdown, chunker version 4, inline body, the projection sealed at its revision and a
        // contextual retrieval mode stamped.
        let current = |slug: &str| {
            put(&store, slug);
            store.set_chunker_version(slug, "4", None).unwrap();
            store
                .update_page_contextual_retrieval_state(slug, "default", "none", None)
                .unwrap();
            store
                .write(|tx| {
                    let mut p = read_page(&*tx, "default", slug)?.unwrap();
                    p.text_projection_revision = Some(p.knowledge_revision.clone());
                    write_page(tx, &p)
                })
                .unwrap();
            page(&store, slug)
        };
        let derived = |slug: &str| {
            rows(&store, &q)
                .into_iter()
                .find(|r| r["slug"] == json!(slug))
                .unwrap()["derived_current"]
                .clone()
        };
        current("notes/all");
        assert_eq!(derived("notes/all"), json!(true));
        // Each term alone turns it false (or NULL for an unknown chunker version).
        current("notes/kind");
        store
            .write(|tx| {
                let mut p = read_page(&*tx, "default", "notes/kind")?.unwrap();
                p.page_kind = "code".into();
                write_page(tx, &p)
            })
            .unwrap();
        assert_eq!(derived("notes/kind"), json!(false));
        current("notes/chunker");
        store
            .set_chunker_version("notes/chunker", "3", None)
            .unwrap();
        assert_eq!(derived("notes/chunker"), json!(false));
        current("notes/null-chunker");
        store
            .write(|tx| {
                let mut p = read_page(&*tx, "default", "notes/null-chunker")?.unwrap();
                p.chunker_version = None;
                write_page(tx, &p)
            })
            .unwrap();
        assert_eq!(derived("notes/null-chunker"), Value::Null);
        let seg = current("notes/segmented");
        store
            .write(|tx| {
                put_json(
                    tx,
                    &crate::page_body::body_key(seg.id),
                    &json!({ "body_storage": "segmented", "body_generation": 1 }),
                )
            })
            .unwrap();
        assert_eq!(derived("notes/segmented"), json!(false));
        current("notes/unsealed");
        store
            .write(|tx| {
                let mut p = read_page(&*tx, "default", "notes/unsealed")?.unwrap();
                p.text_projection_revision = None;
                write_page(tx, &p)
            })
            .unwrap();
        assert_eq!(derived("notes/unsealed"), json!(false));
        put(&store, "notes/no-mode");
        store
            .set_chunker_version("notes/no-mode", "4", None)
            .unwrap();
        store
            .write(|tx| {
                let mut p = read_page(&*tx, "default", "notes/no-mode")?.unwrap();
                p.text_projection_revision = Some(p.knowledge_revision.clone());
                write_page(tx, &p)
            })
            .unwrap();
        assert_eq!(derived("notes/no-mode"), json!(false));
    }

    #[test]
    fn an_older_uncommitted_or_other_kind_receipt_does_not_prove_a_sync_deletion() {
        let store = store();
        put(&store, "notes/gone");
        store.soft_delete_page("notes/gone", None).unwrap();
        let gone = page(&store, "notes/gone");
        let deleted_at = gone.deleted_at_us.unwrap();
        let q = query(json!({}));
        let receipt = |completed: i64, state: &str, kind: &str| {
            let record = json!({ "id": "r1", "principal_kind": "local", "principal_id": "cli", "request_id": "r1",
                "operation": "sync", "source_id": "default", "source_incarnation": "inc-1", "page_id": gone.id,
                "slug": "notes/gone", "digest": "d", "intent": { "kind": kind }, "authority": {},
                "sequence": 1, "state": state, "created_at_us": completed, "updated_at_us": completed,
                "completed_at_us": completed, "compacted": false });
            store
                .write(|tx| put_json(tx, &keys::request("r1"), &record))
                .unwrap();
            rows(&store, &q)[0]["sync_deleted"].clone()
        };
        assert_eq!(
            receipt(deleted_at - 1, "committed", "managed_sync_delete"),
            json!(false)
        );
        assert_eq!(
            receipt(deleted_at, "failed", "managed_sync_delete"),
            json!(false)
        );
        assert_eq!(receipt(deleted_at, "committed", "put_page"), json!(false));
        // Control: the qualifying receipt proves it.
        assert_eq!(
            receipt(deleted_at, "committed", "managed_sync_delete"),
            json!(true)
        );
    }

    #[test]
    fn a_window_reads_named_pages_of_the_source_with_an_origin_in_id_order() {
        let store = store();
        let a = put(&store, "notes/a");
        let b = put(&store, "notes/b");
        let q = query(json!({}));
        let ids = SyncImportPageWindow::Ids {
            ids: vec![b.id.to_string(), "999".into(), a.id.to_string()],
        };
        let read = store.read_sync_import_page_rows(&q, &ids).unwrap();
        let slugs: Vec<&str> = read
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap())
            .collect();
        assert_eq!(slugs, ["notes/a", "notes/b"]);
        let keyset = SyncImportPageWindow::After {
            after: a.id as i64,
            limit: 1,
        };
        let read = store.read_sync_import_page_rows(&q, &keyset).unwrap();
        assert_eq!(read[0]["slug"], json!("notes/b"));
        assert_eq!(read.as_array().unwrap().len(), 1);
        let bad = SyncImportPageWindow::Ids {
            ids: vec!["x".into()],
        };
        assert!(store.read_sync_import_page_rows(&q, &bad).is_err());
    }
}
