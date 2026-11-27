//! The memory-trust evals' catalog reads and text scan (src/core/engine-sql/eval-harness-reads.ts):
//! `hasTable`, `hasColumn`, `listTextBearingColumns` and `scanTextColumns`. A SQL engine answers
//! them from its catalog and scans every text-bearing column of every table; this store has no
//! catalog, so it answers from its records instead (rust/docs/store/eval-harness-reads.md):
//!
//! - The records of the SQL tables the evals name (`MAPPED`) take that table's name, and
//!   `hasTable`/`hasColumn` answer from that list: a table it names exists, with the columns it
//!   lists (the record's fields, with a timestamp's `_us` suffix dropped). Every other table name
//!   answers false.
//! - Every other record takes its keyspace (`keyspaces.rs`) as its table: `<family>/<kind or
//!   records>`. A scan reads every stored record of every keyspace, so a copy kept anywhere is
//!   found; table and column names differ from the SQL engines for records the list does not map.
//! - A record that is a JSON object is read field by field: a string field is a text column, an
//!   object or array field a jsonb column (its compact JSON text). A config row (raw text, which
//!   may parse as JSON) and any other stored value is one text column, `value`, read as UTF-8.
//!   Keys are not read, except the `source_id` and `content_hash` a `page_purges` key holds.
//! - activeOnly leaves out an expired or deleted record (`expired_at_us`, `deleted_at_us`,
//!   `deleted_at`), an inactive take, a record of a deleted page (by its `page_id`, a page id in
//!   its key, or a fence fact's `source_id` and `source_markdown_slug`) and every derived index
//!   keyspace (`DERIVED`).
//! - Hits are sorted by table, column and value in UTF-8 byte order, as the SQL engines sort them,
//!   and at most `limit` are kept while scanning.
//!
//! The match is a case-insensitive substring: the pattern and each value are lowercased
//! (`str::to_lowercase`, which agrees with Postgres `lower()` on ASCII text).

use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::keyspaces::KEYSPACES;
use crate::kv::{KvRead, scan_prefix};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A SQL table whose rows this store keeps as records under one key prefix, with its columns.
struct Mapped {
    table: &'static str,
    prefix: &'static [u8],
    columns: &'static [&'static str],
}

const MAPPED: &[Mapped] = &[
    Mapped {
        table: "pages",
        prefix: &[keys::PAGE],
        columns: &[
            "id",
            "source_id",
            "slug",
            "type",
            "page_kind",
            "title",
            "compiled_truth",
            "timeline",
            "frontmatter",
            "content_hash",
            "chunker_version",
            "source_path",
            "knowledge_revision",
            "text_projection_revision",
            "created_at",
            "updated_at",
            "deleted_at",
            "effective_date",
            "effective_date_source",
            "import_filename",
            "source_kind",
            "source_uri",
            "database_only_reason",
            "ingested_via",
            "ingested_at",
            "tags",
            "tag_sources",
            "trust_tier",
            "write_origin",
            "version_history_gap_at",
            "revision_receipt",
        ],
    },
    Mapped {
        table: "content_chunks",
        prefix: &[keys::CHUNK],
        columns: &[
            "id",
            "page_id",
            "chunk_index",
            "chunk_text",
            "chunk_source",
            "modality",
            "length",
            "meta",
        ],
    },
    Mapped {
        table: "facts",
        prefix: &[keys::FACT, 0x01],
        columns: &[
            "id",
            "source_id",
            "entity_slug",
            "fact",
            "kind",
            "visibility",
            "notability",
            "context",
            "valid_from",
            "valid_until",
            "expired_at",
            "superseded_by",
            "consolidated_at",
            "consolidated_into",
            "source",
            "source_session",
            "confidence",
            "embedding",
            "embedding_model",
            "embedded_text_hash",
            "embedded_at",
            "created_at",
            "row_num",
            "source_markdown_slug",
            "claim_metric",
            "claim_value",
            "claim_unit",
            "claim_period",
            "event_type",
            "dimension",
            "value",
            "value_hash",
            "dim_status",
            "attributed_to",
            "trust_tier",
            "write_origin",
            "source_window",
        ],
    },
    Mapped {
        table: "takes",
        prefix: &[keys::TAKE, 0x01],
        columns: &[
            "id",
            "page_id",
            "source_id",
            "row_num",
            "claim",
            "kind",
            "holder",
            "weight",
            "since_date",
            "until_date",
            "source",
            "superseded_by",
            "active",
            "resolved_at",
            "resolved_outcome",
            "resolved_quality",
            "resolved_value",
            "resolved_unit",
            "resolved_source",
            "resolved_by",
            "created_at",
            "updated_at",
            "trust_tier",
            "write_origin",
        ],
    },
    Mapped {
        table: "timeline_entries",
        prefix: &[keys::TIMELINE],
        columns: &[
            "id",
            "page_id",
            "date",
            "source",
            "summary",
            "detail",
            "event_page_id",
            "created_at",
            "trust_tier",
            "write_origin",
        ],
    },
    Mapped {
        table: "sources",
        prefix: &[keys::SOURCE],
        columns: &[
            "id",
            "name",
            "local_path",
            "last_sync_at",
            "config",
            "incarnation",
            "archived",
            "created_at",
            "chunker_version",
            "archived_at",
            "archive_expires_at",
            "upstream_checked_at",
            "upstream_commit",
            "upstream_behind",
            "last_commit",
            "newest_content_at",
            "purge_epoch",
        ],
    },
    Mapped {
        table: "write_gate_receipts",
        prefix: &[keys::TRUST, 0x02],
        columns: &[
            "id",
            "target_table",
            "target_id",
            "source_id",
            "content_hash",
            "tier",
            "detector_version",
            "verdict",
            "reason_families",
            "reasons",
            "detector_error",
            "request_id",
            "created_at",
            "last_seen_at",
        ],
    },
    Mapped {
        table: "write_gate_holds",
        prefix: &[keys::TRUST, 0x04],
        columns: &[
            "id",
            "kind",
            "source_id",
            "slug",
            "fingerprint",
            "detector_version",
            "tier",
            "reason_families",
            "reasons",
            "detector_error",
            "payload",
            "write_origin",
            "request_id",
            "status",
            "seen_count",
            "created_at",
            "last_seen_at",
            "decided_at",
            "decided_by",
        ],
    },
    Mapped {
        table: "trust_proposals",
        prefix: &[keys::TRUST, 0x06],
        columns: &[
            "id",
            "action",
            "source_id",
            "target_table",
            "target_id",
            "related_table",
            "related_id",
            "before_state",
            "after_state",
            "proposer",
            "status",
            "decided_at",
            "decided_principal_kind",
            "decided_principal_id",
            "created_at",
            "updated_at",
        ],
    },
    Mapped {
        table: "page_purges",
        prefix: &[keys::FACT, 0x0C],
        columns: &[
            "source_id",
            "content_hash",
            "slug",
            "request_id",
            "purged_at",
        ],
    },
];

/// `scanTextColumns({ pattern, tables?, activeOnly, limit? })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextScanQuery {
    pub pattern: String,
    #[serde(default)]
    pub tables: Option<Vec<String>>,
    #[serde(default)]
    pub active_only: bool,
    #[serde(default)]
    pub limit: Option<u64>,
}

/// The table a stored key belongs to: a mapped SQL table, else its keyspace.
fn table_of(key: &[u8]) -> String {
    if let Some(m) = MAPPED.iter().find(|m| key.starts_with(m.prefix)) {
        return m.table.to_string();
    }
    let Some(&tag) = key.first() else {
        return "unknown".into();
    };
    let Some(space) = KEYSPACES.iter().find(|k| k.tag == tag) else {
        return format!("unknown/{}", char::from(tag));
    };
    let name = key
        .get(1)
        .and_then(|b| space.kinds.iter().find(|k| k.kind == *b))
        .map_or(space.records, |k| k.name);
    format!("{}/{}", space.family, name.replace(' ', "_"))
}

/// One text column of a stored value: its name, its text and its kind (`text` or `jsonb`).
type TextColumn = (String, String, &'static str);

/// The text columns of one stored record: `(column, text)` for each string field and the compact
/// JSON text of each object or array field of a JSON object, plus the text columns its key holds
/// (`page_purges`: `source_id` and `content_hash`); a config row (raw text) or any other value is
/// the whole value as `value`, read as UTF-8.
fn text_columns(
    table: &str,
    key: &[u8],
    value: &[u8],
) -> (Vec<TextColumn>, Option<Map<String, Value>>) {
    let raw = || {
        vec![(
            "value".to_string(),
            String::from_utf8_lossy(value).into_owned(),
            "text",
        )]
    };
    if key.first() == Some(&keys::CONFIG) {
        return (raw(), None);
    }
    let (mut out, record) = match serde_json::from_slice::<Value>(value) {
        Ok(Value::Object(map)) => {
            let mut out = Vec::new();
            for (field, v) in &map {
                match v {
                    Value::String(s) => out.push((field.clone(), s.clone(), "text")),
                    Value::Object(_) | Value::Array(_) => {
                        out.push((field.clone(), v.to_string(), "jsonb"))
                    }
                    _ => {}
                }
            }
            (out, Some(map))
        }
        Ok(Value::String(s)) => (vec![("value".into(), s, "text")], None),
        _ => (raw(), None),
    };
    if table == "page_purges" {
        // The key is `F 0x0C source \0 content_hash \0`.
        let mut parts = key.get(2..).unwrap_or_default().split(|b| *b == 0);
        for column in ["source_id", "content_hash"] {
            if let Some(part) = parts.next() {
                out.push((
                    column.into(),
                    String::from_utf8_lossy(part).into_owned(),
                    "text",
                ));
            }
        }
    }
    (out, record)
}

/// The page a derived record of a page belongs to, read from its key: the page id index
/// (`I <id>`) and the page body rows keyed by page id (`b 0x02|0x04|0x05|0x08 <id> ...`).
fn key_page_id(key: &[u8]) -> Option<u64> {
    match *key.first()? {
        keys::PAGE_ID => keys::be8(key.get(1..9)?),
        keys::PAGE_BODY if matches!(key.get(1)?, 0x02 | 0x04 | 0x05 | 0x08) => {
            keys::be8(key.get(2..10)?)
        }
        _ => None,
    }
}

/// Keyspaces that only index or cache other records (postings, trigrams, vectors, link and
/// timeline indexes, query state). activeOnly leaves them out: what they copy is read from the
/// records they index, which activeOnly filters, and a deleted page's index entries cannot be told
/// from a live one's by their values.
const DERIVED: &[u8] = &[
    keys::POSTING,
    keys::TRIGRAM,
    keys::VECTOR,
    keys::LINK_TO,
    keys::LINK_UNIQUE,
    keys::LINK_ORIGIN,
    keys::TIMELINE_DEDUP,
    keys::TIMELINE_LATEST,
    keys::REQUEST_ID,
    keys::CHUNK_QUERIES,
    keys::LINK_QUERIES,
    keys::TIMELINE_QUERIES,
];

/// The fields of a page the scan needs (the page body is not read).
#[derive(Deserialize)]
struct PageHead {
    id: u64,
    source_id: String,
    slug: String,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

fn text_field<'a>(record: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    record.get(field).and_then(Value::as_str)
}

fn id_field(record: &Map<String, Value>, field: &str) -> Option<u64> {
    record.get(field).and_then(Value::as_u64)
}

fn set(record: &Map<String, Value>, field: &str) -> bool {
    record.get(field).is_some_and(|v| !v.is_null())
}

impl Store {
    /// `hasTable(name)`: whether `name` is one of the SQL tables this store keeps records of.
    pub fn has_table(&self, name: &str) -> Result<bool> {
        Ok(MAPPED.iter().any(|m| m.table == name))
    }

    /// `hasColumn(table, column)`: whether the mapped table has the column.
    pub fn has_column(&self, table: &str, column: &str) -> Result<bool> {
        Ok(MAPPED
            .iter()
            .any(|m| m.table == table && m.columns.contains(&column)))
    }

    /// `listTextBearingColumns`: `{ table, column, data_type, udt_name }` for each text field the
    /// stored records carry, by table then column. A table with no record lists nothing.
    pub fn list_text_bearing_columns(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut seen: BTreeMap<(String, String), &'static str> = BTreeMap::new();
        scan_prefix(&*read, &[], false, &mut |k, v| {
            let table = table_of(k);
            for (column, _, kind) in text_columns(&table, k, v).0 {
                seen.entry((table.clone(), column)).or_insert(kind);
            }
            true
        })?;
        Ok(seen
            .into_iter()
            .map(|((table, column), kind)| json!({ "table": table, "column": column, "data_type": kind, "udt_name": kind }))
            .collect())
    }

    /// `scanTextColumns`: `{ table, column, slug, page_id, entity_slug, value }` for each text value
    /// of each stored record that contains `pattern` (case-insensitive), by table, column and value,
    /// at most `limit`. `activeOnly` leaves out an expired fact, a deleted page, an inactive take and
    /// any record of a deleted page.
    pub fn scan_text_columns(&self, q: &TextScanQuery) -> Result<Vec<Value>> {
        let pattern = q.pattern.to_lowercase();
        if pattern.is_empty() {
            return Err(StoreError::invalid("scanTextColumns: the pattern is empty"));
        }
        let read = self.read()?;
        let mut pages: Vec<PageHead> = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::PAGE], false, &mut |_, v| {
            match serde_json::from_slice::<PageHead>(v) {
                Ok(p) => pages.push(p),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let slug_of: HashMap<u64, &str> = pages.iter().map(|p| (p.id, p.slug.as_str())).collect();
        let deleted: BTreeSet<u64> = pages
            .iter()
            .filter(|p| p.deleted_at_us.is_some())
            .map(|p| p.id)
            .collect();
        let deleted_keys: BTreeSet<(&str, &str)> = pages
            .iter()
            .filter(|p| p.deleted_at_us.is_some())
            .map(|p| (p.source_id.as_str(), p.slug.as_str()))
            .collect();
        let tables: Option<BTreeSet<&str>> = q
            .tables
            .as_ref()
            .map(|t| t.iter().map(String::as_str).collect());
        let limit = q.limit.map(|n| usize::try_from(n).unwrap_or(usize::MAX));
        let mut hits: Vec<Hit> = Vec::new();
        scan(&*read, &mut |k, v| {
            if q.active_only && k.first().is_some_and(|t| DERIVED.contains(t)) {
                return;
            }
            let table = table_of(k);
            if tables.as_ref().is_some_and(|t| !t.contains(table.as_str())) {
                return;
            }
            let (columns, record) = text_columns(&table, k, v);
            let page_id = record
                .as_ref()
                .and_then(|r| {
                    if table == "pages" {
                        id_field(r, "id")
                    } else {
                        id_field(r, "page_id")
                    }
                })
                .or_else(|| key_page_id(k));
            if q.active_only {
                if let Some(r) = &record
                    && (set(r, "expired_at_us")
                        || set(r, "deleted_at_us")
                        || set(r, "deleted_at")
                        || (table == "takes" && r.get("active") == Some(&Value::Bool(false)))
                        || text_field(r, "source_id")
                            .zip(text_field(r, "source_markdown_slug"))
                            .is_some_and(|key| deleted_keys.contains(&key)))
                {
                    return;
                }
                if page_id.is_some_and(|id| deleted.contains(&id)) {
                    return;
                }
            }
            let entity = record
                .as_ref()
                .and_then(|r| text_field(r, "entity_slug"))
                .map(str::to_string);
            let own = record.as_ref().and_then(|r| {
                let order: &[&str] = if table == "facts" {
                    &["entity_slug", "source_markdown_slug"]
                } else {
                    &["slug", "page_slug", "entity_slug"]
                };
                order
                    .iter()
                    .find_map(|f| text_field(r, f))
                    .map(str::to_string)
            });
            let slug =
                own.or_else(|| page_id.and_then(|id| slug_of.get(&id).map(|s| s.to_string())));
            for (column, text, _) in columns {
                if text.to_lowercase().contains(&pattern) {
                    hits.push(Hit {
                        table: table.clone(),
                        column,
                        value: text,
                        slug: slug.clone(),
                        page_id,
                        entity_slug: entity.clone(),
                    });
                }
            }
            // Keep at most `limit` hits: past twice that, sort and drop the tail.
            if let Some(n) = limit
                && hits.len() > n.saturating_mul(2).max(64)
            {
                sort_hits(&mut hits);
                hits.truncate(n);
            }
        })?;
        sort_hits(&mut hits);
        hits.truncate(limit.unwrap_or(usize::MAX));
        Ok(hits
            .into_iter()
            .map(|h| json!({ "table": h.table, "column": h.column, "slug": h.slug, "page_id": h.page_id, "entity_slug": h.entity_slug, "value": h.value }))
            .collect())
    }
}

/// One scan hit.
struct Hit {
    table: String,
    column: String,
    value: String,
    slug: Option<String>,
    page_id: Option<u64>,
    entity_slug: Option<String>,
}

/// By table, column and value, in UTF-8 byte order (the SQL engines order by `convert_to(..., 'UTF8')`).
fn sort_hits(hits: &mut [Hit]) {
    hits.sort_by(|a, b| (&a.table, &a.column, &a.value).cmp(&(&b.table, &b.column, &b.value)));
}

/// Calls `f` with every stored key and value.
fn scan(read: &dyn KvRead, f: &mut dyn FnMut(&[u8], &[u8])) -> Result<()> {
    scan_prefix(read, &[], false, &mut |k, v| {
        f(k, v);
        true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mapped_prefix_names_its_sql_table_and_any_other_key_its_keyspace() {
        assert_eq!(table_of(&[keys::FACT, 0x01, 0, 0]), "facts");
        assert_eq!(table_of(&[keys::TAKE, 0x01, 0]), "takes");
        assert_eq!(table_of(&[keys::TAKE, 0x02, 0]), "takes/take_by_row");
        assert_eq!(table_of(&[keys::PAGE, b'x']), "pages");
    }

    #[test]
    fn a_json_record_is_read_field_by_field_and_other_bytes_as_one_value() {
        let (cols, _) = text_columns(
            "facts",
            &[keys::FACT, 0x01],
            br#"{"fact":"Alpha","n":3,"tags":["a"],"meta":null}"#,
        );
        assert_eq!(
            cols,
            vec![
                ("fact".to_string(), "Alpha".to_string(), "text"),
                ("tags".to_string(), r#"["a"]"#.to_string(), "jsonb")
            ]
        );
        let (cols, _) = text_columns("x", b"x", &[0xff, b'h', b'i']);
        assert_eq!(cols[0].0, "value");
        // A top-level JSON array or scalar, and any config row, is one raw-text value.
        let (cols, _) = text_columns("x", b"x", br#"["arraytoken"]"#);
        assert_eq!(
            cols,
            vec![("value".to_string(), r#"["arraytoken"]"#.to_string(), "text")]
        );
        let (cols, _) = text_columns(
            "core/config_rows",
            &[keys::CONFIG, b'k'],
            br#"{"keytoken":1}"#,
        );
        assert_eq!(
            cols,
            vec![("value".to_string(), r#"{"keytoken":1}"#.to_string(), "text")]
        );
        // A page purge's source and content hash are in its key.
        let mut key = vec![keys::FACT, 0x0C];
        key.extend_from_slice(b"default\0abc123\0");
        let (cols, _) = text_columns("page_purges", &key, br#"{"slug":"notes/a"}"#);
        assert_eq!(
            cols.iter()
                .map(|c| (c.0.as_str(), c.1.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("slug", "notes/a"),
                ("source_id", "default"),
                ("content_hash", "abc123")
            ]
        );
    }

    /// The listed columns of a mapped table are fields its stored record carries (a timestamp's `_us`
    /// suffix dropped), so `hasColumn` does not drift from the records.
    #[test]
    fn mapped_columns_are_fields_of_the_stored_records() {
        let fields = |v: &Value| -> BTreeSet<String> {
            v.as_object()
                .unwrap()
                .keys()
                .map(|k| k.strip_suffix("_us").unwrap_or(k).to_string())
                .collect()
        };
        let check = |table: &str, have: BTreeSet<String>| {
            let m = MAPPED.iter().find(|m| m.table == table).unwrap();
            let missing: Vec<_> = m.columns.iter().filter(|c| !have.contains(**c)).collect();
            assert!(
                missing.is_empty(),
                "{table} lists columns its record does not carry: {missing:?}"
            );
        };
        // `embedding` and `source_window` are left out of a record while unset (skip_serializing_if).
        let mut facts = fields(&serde_json::to_value(crate::facts::FactRecord::default()).unwrap());
        facts.extend(["embedding".to_string(), "source_window".to_string()]);
        check("facts", facts);
        let store = crate::test_support::store();
        let input: crate::pages::PageInput =
            serde_json::from_value(json!({"type": "note", "title": "t", "compiled_truth": "x"}))
                .unwrap();
        let opts: crate::pages::PutPageOptions = serde_json::from_value(json!({})).unwrap();
        store.put_page("notes/t", &input, &opts).unwrap();
        let read = store.read().unwrap();
        let mut page = None;
        scan_prefix(&*read, &[keys::PAGE], false, &mut |_, v| {
            page = serde_json::from_slice::<Value>(v).ok();
            false
        })
        .unwrap();
        // These page fields are left out of a record while unset (skip_serializing_if).
        let mut pages = fields(&page.unwrap());
        pages.extend(
            [
                "database_only_reason",
                "tag_sources",
                "trust_tier",
                "write_origin",
                "version_history_gap_at",
                "revision_receipt",
            ]
            .map(String::from),
        );
        check("pages", pages);
    }
}
