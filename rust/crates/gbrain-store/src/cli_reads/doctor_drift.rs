//! The provenance-drift reads served from the store (SQL in `src/core/engine-sql/doctor-acc.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-acc.md`): the live pages of a source and the versions of those pages.
//!
//! The writer columns come from the attribution the page writer stamps (`pages::write_page`, as
//! `gbrain_stamp_revision_attribution` does) and the version writer stamps (`pages::snapshot_in`, as
//! `gbrain_stamp_version_attribution` does): `req` and `kind` are the revision's (a version's archiving) request and
//! principal kind, and `remote` is `authority->>'remote'` of that request, NULL when no request row holds the id (the
//! SQL's LEFT JOIN).
//!
//! The batch scan reads every page record and filters in memory (the store has no `(source, id)` index), so a scan of a
//! large source pays one pass per batch of 500 pages.

use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, RevisionWriter, VersionRecord, all_pages, read_page};
use crate::persistence::{json_text, request_by_id};
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

/// `r.authority->>'remote'` of `LEFT JOIN persistence_requests r ON r.id = <req>`.
fn remote_of(read: &dyn KvRead, req: Option<&str>) -> Result<Option<String>> {
    let Some(id) = req else { return Ok(None) };
    Ok(request_by_id(read, id)?.and_then(|r| json_text(r.authority.get("remote"))))
}

fn writer_columns(read: &dyn KvRead, writer: &RevisionWriter) -> Result<(Value, Value, Value)> {
    Ok((
        json!(writer.request_id),
        json!(writer.principal_kind),
        json!(remote_of(read, writer.request_id.as_deref())?),
    ))
}

fn live_row(read: &dyn KvRead, p: &PageRecord) -> Result<Value> {
    let (req, kind, remote) = writer_columns(read, &p.revision_writer)?;
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
                let (req, kind, remote) = writer_columns(&*read, &row.archived_by)?;
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
