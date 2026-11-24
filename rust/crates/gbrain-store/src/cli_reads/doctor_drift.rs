//! The provenance-drift reads served from the store (SQL in `src/core/engine-sql/doctor-acc.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-acc.md`): the live pages of a source and the versions of those pages.
//!
//! Write attribution comes from the record receipts (`write_receipt.rs`): a live row's `req` and `kind` are the page's
//! revision receipt (`pages.revision_write_request_id`, `revision_principal_kind`), a version row's are its archived actor
//! (`page_versions.archived_write_request_id`, `archived_principal_kind`), and `remote` is the `remote` key of the
//! attributed journal request's authority as `->>` reads it (text, null when the request or the key is absent), as the
//! SQL's `LEFT JOIN persistence_requests` does. An unattributed write answers all three as null.
//!
//! The batch scan reads every page record and filters in memory (the store has no `(source, id)` index), so a scan of a
//! large source pays one pass per batch of 500 pages.

use crate::Store;
use crate::env::{is_uuid, iso};
use crate::error::Result;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, VersionRecord, all_pages, read_page};
use crate::persistence::request_by_id;
use crate::write_receipt::ActorColumns;
use crate::{StoreError, links::no_nul};
use serde::Deserialize;
use serde_json::{Value, json};

/// `DRIFT_BATCH` (`engine-sql/doctor-acc.ts`): the page-batch size of the live read.
const DRIFT_BATCH: usize = 500;

/// `listDriftLiveRows(schema, sourceId, { after } | { slug })`: `slug` set reads that page, else the batch after `after`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriftLiveSpec {
    pub source_id: String,
    #[serde(default)]
    pub after: Option<i64>,
    #[serde(default)]
    pub slug: Option<String>,
}

/// `listDriftVersionRows(schema, pageIds)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriftVersionsSpec {
    pub page_ids: Vec<i64>,
}

/// `ingested_at` as `Date.prototype.toISOString` writes it (milliseconds), the text the TypeScript row reads a driver
/// timestamp into.
fn millis_iso(micros: i64) -> String {
    let text = iso(micros);
    format!("{}Z", &text[..text.len() - 4])
}

/// `req`, `kind` and `remote` of one actor: the request id as the `::text` cast writes it, the principal kind, and the
/// `remote` key of the request's authority as `authority->>'remote'` reads it.
fn attribution(read: &dyn KvRead, actor: &ActorColumns) -> Result<(Value, Value, Value)> {
    let req = actor.request_id.as_deref().map(str::to_lowercase);
    let remote = match req.as_deref().filter(|id| is_uuid(id)) {
        Some(id) => match request_by_id(read, id)?.and_then(|r| r.authority.get("remote").cloned())
        {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(text)) => Value::String(text),
            Some(other) => Value::String(other.to_string()),
        },
        None => Value::Null,
    };
    Ok((json!(req), json!(actor.principal_kind), remote))
}

fn live_row(read: &dyn KvRead, p: &PageRecord) -> Result<Value> {
    let (req, kind, remote) = attribution(read, &p.revision_receipt)?;
    Ok(json!({
        "id": p.id,
        "slug": p.slug,
        "trust_tier": p.trust_tier.as_deref().unwrap_or("unknown"),
        "frontmatter": p.frontmatter,
        "revision": p.knowledge_revision,
        "source_kind": p.source_kind,
        "ingested_via": p.ingested_via,
        "ingested_at": p.ingested_at_us.map(millis_iso),
        "req": req,
        "kind": kind,
        "remote": remote,
    }))
}

impl Store {
    /// `listDriftLiveRows`: the live pages of a source by id (at most 500 after `after`), or the live page at `slug`.
    pub fn list_drift_live_rows(&self, spec: &DriftLiveSpec) -> Result<Vec<Value>> {
        let op = "listDriftLiveRows";
        no_nul(op, &[("sourceId", &spec.source_id)])?;
        let read = self.read()?;
        if let Some(slug) = &spec.slug {
            no_nul(op, &[("slug", slug)])?;
            let page = read_page(&*read, &spec.source_id, slug)?;
            return page
                .filter(|p| p.deleted_at_us.is_none())
                .iter()
                .map(|p| live_row(&*read, p))
                .collect();
        }
        let after = spec.after.unwrap_or(0);
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == spec.source_id
                    && p.deleted_at_us.is_none()
                    && i128::from(p.id) > i128::from(after)
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        pages.truncate(DRIFT_BATCH);
        pages.iter().map(|p| live_row(&*read, p)).collect()
    }

    /// `listDriftVersionRows`: the versions of these pages, by page id then version id.
    pub fn list_drift_version_rows(&self, spec: &DriftVersionsSpec) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut ids: Vec<u64> = spec
            .page_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let mut versions = Vec::new();
        for page_id in ids {
            let mut failure = None;
            scan_prefix(
                &*read,
                &keys::version_prefix(page_id),
                false,
                &mut |_, v| {
                    match serde_json::from_slice::<VersionRecord>(v) {
                        Ok(row) => versions.push(row),
                        Err(e) => failure = Some(StoreError::from(e)),
                    }
                    failure.is_none()
                },
            )?;
            if let Some(e) = failure {
                return Err(e);
            }
        }
        versions
            .iter()
            .map(|row| {
                let (req, kind, remote) = attribution(&*read, &row.receipt.archived)?;
                Ok(json!({
                    "page_id": row.page_id,
                    "frontmatter": row.frontmatter,
                    "req": req,
                    "kind": kind,
                    "remote": remote,
                }))
            })
            .collect()
    }
}
