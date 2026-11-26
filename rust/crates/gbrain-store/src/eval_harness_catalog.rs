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
//!   object or array field a jsonb column (its compact JSON text). Any other stored value is one
//!   text column, `value`, read as UTF-8. Keys are not read.
//!
//! The match is a case-insensitive substring: the pattern and each value are lowercased
//! (`str::to_lowercase`, which agrees with Postgres `lower()` on ASCII text).

use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::keyspaces::KEYSPACES;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::all_pages;
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

/// The text columns of one stored value: `(column, text)` for each string field and the compact JSON
/// text of each object or array field of a JSON object; else the whole value as `value`.
fn text_columns(
    value: &[u8],
) -> (
    Vec<(String, String, &'static str)>,
    Option<Map<String, Value>>,
) {
    match serde_json::from_slice::<Value>(value) {
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
        Ok(_) => (Vec::new(), None),
        Err(_) => (
            vec![(
                "value".into(),
                String::from_utf8_lossy(value).into_owned(),
                "text",
            )],
            None,
        ),
    }
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
            for (column, _, kind) in text_columns(v).0 {
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
        let pages = all_pages(&*read)?;
        let slug_of: HashMap<u64, &str> = pages.iter().map(|p| (p.id, p.slug.as_str())).collect();
        let deleted: BTreeSet<u64> = pages
            .iter()
            .filter(|p| p.deleted_at_us.is_some())
            .map(|p| p.id)
            .collect();
        let tables: Option<BTreeSet<&str>> = q
            .tables
            .as_ref()
            .map(|t| t.iter().map(String::as_str).collect());
        let mut hits: Vec<(String, String, String, Value)> = Vec::new();
        scan(&*read, &mut |k, v| {
            let table = table_of(k);
            if tables.as_ref().is_some_and(|t| !t.contains(table.as_str())) {
                return;
            }
            let (columns, record) = text_columns(v);
            let page_id = record.as_ref().and_then(|r| {
                if table == "pages" {
                    id_field(r, "id")
                } else {
                    id_field(r, "page_id")
                }
            });
            if q.active_only {
                if let Some(r) = &record
                    && (set(r, "expired_at_us")
                        || set(r, "deleted_at_us")
                        || (table == "takes" && r.get("active") == Some(&Value::Bool(false))))
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
                    let row = json!({ "table": table, "column": column, "slug": slug, "page_id": page_id, "entity_slug": entity, "value": text });
                    hits.push((table.clone(), column, text, row));
                }
            }
        })?;
        hits.sort_by(|a, b| (&a.0, &a.1, &a.2).cmp(&(&b.0, &b.1, &b.2)));
        let limit = q
            .limit
            .map_or(usize::MAX, |n| usize::try_from(n).unwrap_or(usize::MAX));
        Ok(hits.into_iter().take(limit).map(|h| h.3).collect())
    }
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
        let (cols, _) = text_columns(br#"{"fact":"Alpha","n":3,"tags":["a"],"meta":null}"#);
        assert_eq!(
            cols,
            vec![
                ("fact".to_string(), "Alpha".to_string(), "text"),
                ("tags".to_string(), r#"["a"]"#.to_string(), "jsonb")
            ]
        );
        let (cols, _) = text_columns(&[0xff, b'h', b'i']);
        assert_eq!(cols[0].0, "value");
    }
}
