//! The identity-downgrade read (`readIdentityDowngradeRows`, `src/core/engine-sql/sync-status-reads.ts`;
//! rust/docs/store/persistence.md, "Identity-downgrade read"): the open records of
//! `src/core/sync-identity-downgrades.ts`, each joined to its old page and to the live slugs of
//! that page's source at the record's new path.
//!
//! A record is one `op_checkpoints` row (op `sync-identity-downgrade`, fingerprint = the old page
//! id as text) whose `completed_keys[0]` holds it. It reads, as the statement reads it, when a page
//! has that id, the page is soft-deleted at the record's `old_deleted_at` instant (parsed as
//! `::timestamptz` parses it; text it cannot parse refuses as the cast does), the record has no
//! `disposition`, the page is in the record's `source_id` and, when `sourceIds` is given, in one of
//! them. Rows order by `recorded_at` (byte order; a missing one last), then the fingerprint.
//! `new_slugs` lists, in byte order, the live pages of the old page's source whose `source_path`
//! is the record's `to`, or is null when none.

use super::housekeeping::HousekeepingRow;
use super::projection_queue::parse_timestamptz;
use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, read_page_by_id};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `IdentityDowngradeSpec`: the checkpoint op the records live under and the sources asked
/// about (`None`: every source).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IdentityDowngradeSpec {
    pub op: String,
    pub source_ids: Option<Vec<String>>,
}

/// `x->>'name'`: the text of a JSON field, null when it is missing or JSON null.
fn field_text(record: &Value, name: &str) -> Option<String> {
    match record.get(name)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// An open record and the page it names, before the new-path join.
struct Open {
    fingerprint: String,
    record: Value,
    recorded_at: Option<String>,
    source_id: String,
    to: Option<String>,
}

/// The op's rows in fingerprint byte order, as `(fingerprint, completed_keys)`.
fn op_rows(read: &dyn KvRead, op: &str) -> Result<Vec<(String, Value)>> {
    if op.contains('\0') {
        return Ok(Vec::new());
    }
    let mut prefix = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    prefix.extend_from_slice(op.as_bytes());
    prefix.push(0);
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        match serde_json::from_slice::<HousekeepingRow>(v) {
            Ok(row) => out.push((
                String::from_utf8_lossy(&k[prefix.len()..]).into_owned(),
                row.completed_keys,
            )),
            Err(e) => bad = Some(StoreError::from(e)),
        }
        bad.is_none()
    })?;
    match bad {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

/// The old page a fingerprint names: only the canonical decimal text of a page id joins
/// (`p.id::text = dg.fingerprint`).
fn old_page(read: &dyn KvRead, fingerprint: &str) -> Result<Option<PageRecord>> {
    match fingerprint.parse::<u64>() {
        Ok(id) if id.to_string() == fingerprint => read_page_by_id(read, id),
        _ => Ok(None),
    }
}

/// The record when it is open for `page` within the asked-for sources, else `None`.
fn open_record(
    fingerprint: String,
    completed_keys: &Value,
    page: &PageRecord,
    wanted: Option<&BTreeSet<&str>>,
) -> Result<Option<Open>> {
    let Some(deleted_at) = page.deleted_at_us else {
        return Ok(None);
    };
    let record = completed_keys.get(0).cloned().unwrap_or(Value::Null);
    if field_text(&record, "disposition").is_some() {
        return Ok(None);
    }
    let Some(old_deleted_at) = field_text(&record, "old_deleted_at") else {
        return Ok(None);
    };
    let at = parse_timestamptz(&old_deleted_at, "old_deleted_at").map_err(|_| {
        StoreError::invalid(format!(
            "invalid input syntax for type timestamp with time zone: \"{old_deleted_at}\""
        ))
    })?;
    if at != deleted_at
        || field_text(&record, "source_id").as_deref() != Some(page.source_id.as_str())
        || wanted.is_some_and(|w| !w.contains(page.source_id.as_str()))
    {
        return Ok(None);
    }
    Ok(Some(Open {
        fingerprint,
        recorded_at: field_text(&record, "recorded_at"),
        to: field_text(&record, "to"),
        source_id: page.source_id.clone(),
        record,
    }))
}

/// The live slugs of `source_id` at each of `paths`, read one page at a time.
fn live_slugs_at(
    read: &dyn KvRead,
    source_id: &str,
    paths: &BTreeSet<String>,
) -> Result<BTreeMap<String, Vec<String>>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut bad = None;
    scan_prefix(
        read,
        &keys::text(keys::PAGE, &[source_id, ""]),
        false,
        &mut |_, v| {
            match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => {
                    if page.deleted_at_us.is_none()
                        && let Some(path) = page.source_path.as_ref().filter(|p| paths.contains(*p))
                    {
                        out.entry(path.clone()).or_default().push(page.slug);
                    }
                }
                Err(e) => bad = Some(StoreError::from(e)),
            }
            bad.is_none()
        },
    )?;
    if let Some(e) = bad {
        return Err(e);
    }
    for slugs in out.values_mut() {
        slugs.sort();
    }
    Ok(out)
}

pub(crate) fn read_identity_downgrade_rows_in(
    read: &dyn KvRead,
    spec: &IdentityDowngradeSpec,
) -> Result<Vec<Value>> {
    let wanted: Option<BTreeSet<&str>> = spec
        .source_ids
        .as_ref()
        .map(|ids| ids.iter().map(String::as_str).collect());
    let mut open = Vec::new();
    for (fingerprint, completed_keys) in op_rows(read, &spec.op)? {
        let Some(page) = old_page(read, &fingerprint)? else {
            continue;
        };
        if let Some(row) = open_record(fingerprint, &completed_keys, &page, wanted.as_ref())? {
            open.push(row);
        }
    }
    // One scan per source, for the new paths its open records name.
    let mut paths: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for row in &open {
        if let Some(to) = &row.to {
            paths
                .entry(row.source_id.as_str())
                .or_default()
                .insert(to.clone());
        }
    }
    let mut live: BTreeMap<String, BTreeMap<String, Vec<String>>> = BTreeMap::new();
    for (source_id, wanted_paths) in &paths {
        live.insert(
            (*source_id).to_string(),
            live_slugs_at(read, source_id, wanted_paths)?,
        );
    }
    open.sort_by(|a, b| {
        let at = match (&a.recorded_at, &b.recorded_at) {
            (Some(x), Some(y)) => x.as_bytes().cmp(y.as_bytes()),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        at.then_with(|| a.fingerprint.as_bytes().cmp(b.fingerprint.as_bytes()))
    });
    Ok(open
        .into_iter()
        .map(|row| {
            let slugs = row
                .to
                .as_ref()
                .and_then(|to| live.get(&row.source_id)?.get(to))
                .filter(|slugs| !slugs.is_empty());
            json!({ "record": row.record, "new_slugs": slugs })
        })
        .collect())
}

impl Store {
    /// `readIdentityDowngradeRows(sourceIds)`: the open identity-downgrade records, oldest first,
    /// each with the live slugs at its new path (null when none).
    pub fn read_identity_downgrade_rows(&self, spec: &IdentityDowngradeSpec) -> Result<Vec<Value>> {
        read_identity_downgrade_rows_in(&*self.read()?, spec)
    }
}
