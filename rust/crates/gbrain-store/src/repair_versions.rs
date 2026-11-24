//! The `page_versions` reads and writes of the batch 6 repair kinds (src/core/engine-sql/version-reasons.ts).
//!
//! - `listVersionsByChangeReason` / `replaceVersionChangeReasons`: `gbrain repair purged-change-reasons` lists the
//!   versions of a source's pages whose stored change reason is one of the purged texts, and its apply replaces each
//!   approved reason only while the version still holds the text the apply found.
//! - `listRetainedVersionBodies`: `gbrain repair redacted-facts` reads the newest retained inline bodies of a page
//!   (a segmented snapshot keeps no body copy and is skipped), newest first, at most `limit`.
//!
//! - `listOverwriteCandidates` / `listVersionsAfter` / `listOverwriteLivePages` / `readVersionContent`:
//!   `gbrain repair overwritten-edits` (and its doctor check) find the database edits a managed sync import archived.
//!   A candidate is a version of a live page whose archiving request (`receipt.archived.request_id`, the stamp
//!   `gbrain_stamp_version_attribution` leaves) is a committed managed-sync import and whose writing request
//!   (`receipt.written.request_id`) is a committed database write that published no file; no `git` effect carries the
//!   version's revision. Request JSON is read with SQL's `->>` text rule ([`json_text`]).
//!
//! - `readArchivedVersionBody`: `gbrain repair accepted-takes` reads the newest version of a page that a request
//!   archived (`receipt.archived.request_id`).
//!
//! A source's versions are the versions of every page row of the source, live or soft-deleted, as the SQL's join
//! on `pages` reads them.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::{PageRecord, VersionRecord, all_pages, read_page_by_id, versions_of};
use crate::persistence::all_effects;
use crate::{get_json, keys, put_json};

/// `listVersionsByChangeReason({ sourceId, reasons })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionReasonQuery {
    pub source_id: String,
    pub reasons: Vec<String>,
}

/// One version holding one of the listed reasons.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionReasonRow {
    pub id: u64,
    pub slug: String,
    pub source_path: Option<String>,
    pub reason: String,
}

/// One approved version and the reason text the apply found on it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct VersionReasonExpect {
    pub id: i64,
    pub reason: String,
}

/// `replaceVersionChangeReasons({ sourceId, rows, replacement })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionReasonReplace {
    pub source_id: String,
    pub rows: Vec<VersionReasonExpect>,
    pub replacement: String,
}

/// `listRetainedVersionBodies({ pageId, limit })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedBodiesQuery {
    pub page_id: i64,
    pub limit: i64,
}

/// One retained inline body.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetainedBody {
    pub id: u64,
    pub compiled_truth: String,
}

/// The page rows of `source_id`, live or soft-deleted.
fn source_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    Ok(all_pages(read)?
        .into_iter()
        .filter(|p| p.source_id == source_id)
        .collect())
}

impl Store {
    /// The versions of the source's pages whose change reason is one of `reasons`, by version id.
    pub fn list_versions_by_change_reason(
        &self,
        q: &VersionReasonQuery,
    ) -> Result<Vec<VersionReasonRow>> {
        let op = "listVersionsByChangeReason";
        no_nul(op, &[("sourceId", &q.source_id)])?;
        for reason in &q.reasons {
            no_nul(op, &[("reasons", reason)])?;
        }
        let wanted: BTreeSet<&str> = q.reasons.iter().map(String::as_str).collect();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut out: BTreeMap<u64, VersionReasonRow> = BTreeMap::new();
        for page in source_pages(&*read, &q.source_id)? {
            for v in versions_of(&*read, page.id)? {
                let Some(reason) = v.change_reason.as_deref() else {
                    continue;
                };
                if wanted.contains(reason) {
                    out.insert(
                        v.id,
                        VersionReasonRow {
                            id: v.id,
                            slug: page.slug.clone(),
                            source_path: v.source_path.clone(),
                            reason: reason.to_string(),
                        },
                    );
                }
            }
        }
        Ok(out.into_values().collect())
    }

    /// Sets `replacement` on each named version of the source's pages that still holds the reason it is named with;
    /// answers the ids it set, by id.
    pub fn replace_version_change_reasons(&self, q: &VersionReasonReplace) -> Result<Vec<u64>> {
        let op = "replaceVersionChangeReasons";
        no_nul(
            op,
            &[("sourceId", &q.source_id), ("replacement", &q.replacement)],
        )?;
        for row in &q.rows {
            no_nul(op, &[("rows.reason", &row.reason)])?;
        }
        let mut expected: BTreeMap<u64, BTreeSet<&str>> = BTreeMap::new();
        for row in &q.rows {
            if let Ok(id) = u64::try_from(row.id) {
                expected.entry(id).or_default().insert(row.reason.as_str());
            }
        }
        if expected.is_empty() {
            return Ok(Vec::new());
        }
        self.write(|tx| {
            let mut set = Vec::new();
            for page in source_pages(&*tx, &q.source_id)? {
                for mut v in versions_of(&*tx, page.id)? {
                    let holds = v.change_reason.as_deref().is_some_and(|reason| {
                        expected
                            .get(&v.id)
                            .is_some_and(|texts| texts.contains(reason))
                    });
                    if holds {
                        v.change_reason = Some(q.replacement.clone());
                        put_json(tx, &keys::version(page.id, v.id), &v)?;
                        set.push(v.id);
                    }
                }
            }
            set.sort_unstable();
            Ok(set)
        })
    }

    /// The page's versions whose body is stored inline, newest first, at most `limit`.
    pub fn list_retained_version_bodies(
        &self,
        q: &RetainedBodiesQuery,
    ) -> Result<Vec<RetainedBody>> {
        let (Ok(page_id), Ok(limit)) = (u64::try_from(q.page_id), usize::try_from(q.limit)) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut out: Vec<RetainedBody> = versions_of(&*read, page_id)?
            .into_iter()
            .filter_map(|v| {
                v.compiled_truth.as_deref().map(|body| RetainedBody {
                    id: v.id,
                    compiled_truth: body.to_string(),
                })
            })
            .collect();
        out.sort_by_key(|r| std::cmp::Reverse(r.id));
        out.truncate(limit);
        Ok(out)
    }

    /// The overwrite candidates of the source's live pages (`slugs` narrows them), newest version first, at most `limit`.
    pub fn list_overwrite_candidates(&self, q: &OverwriteCandidateQuery) -> Result<Vec<Value>> {
        let op = "listOverwriteCandidates";
        no_nul(op, &[("sourceId", &q.source_id)])?;
        for slug in q.slugs.iter().flatten() {
            no_nul(op, &[("slugs", slug)])?;
        }
        let Ok(limit) = usize::try_from(q.limit) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let git_revisions: BTreeSet<String> = all_effects(&*read)?
            .into_iter()
            .filter(|e| e.kind == "git")
            .filter_map(|e| e.revision)
            .collect();
        let mut found: Vec<(u64, Value)> = Vec::new();
        for page in source_pages(&*read, &q.source_id)? {
            if page.deleted_at_us.is_some()
                || q.slugs.as_ref().is_some_and(|s| !s.contains(&page.slug))
            {
                continue;
            }
            for v in versions_of(&*read, page.id)? {
                let (Some(archived), Some(written)) = (
                    v.receipt.archived.request_id.as_deref(),
                    v.receipt.written.request_id.as_deref(),
                ) else {
                    continue;
                };
                let (Some(s), Some(w)) = (
                    request_by_id(&*read, archived)?,
                    request_by_id(&*read, written)?,
                ) else {
                    continue;
                };
                if !(s.state == "committed"
                    && s.operation == "submit_job"
                    && s.source_id == page.source_id
                    && managed_import(&s))
                    || !database_write(&w, &page.source_id)
                    || git_revisions.contains(&v.knowledge_revision)
                {
                    continue;
                }
                let mode = json_text(
                    w.outcome
                        .as_ref()
                        .and_then(|o| o.pointer("/persistence/mode")),
                );
                let mut row = content_json(&v);
                let fields = row.as_object_mut().expect("content_json builds an object");
                fields.insert("version_id".into(), json!(v.id));
                fields.insert("page_id".into(), json!(page.id));
                fields.insert("slug".into(), json!(page.slug));
                fields.insert("lost_revision".into(), json!(v.knowledge_revision));
                fields.insert("db_request_id".into(), json!(w.id));
                fields.insert("db_operation".into(), json!(w.operation));
                fields.insert("import_request_id".into(), json!(s.id));
                fields.insert("imported_at".into(), json!(s.completed_at_us.map(iso)));
                fields.insert(
                    "db_outcome_known".into(),
                    json!(mode.as_deref() == Some("database")),
                );
                found.push((v.id, row));
            }
        }
        found.sort_by_key(|f| std::cmp::Reverse(f.0));
        found.truncate(limit);
        Ok(found.into_iter().map(|(_, row)| row).collect())
    }

    /// The versions of the pages with an id over `afterId`, by id, with their writing request and content.
    pub fn list_versions_after(&self, q: &VersionsAfterQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pages: BTreeSet<u64> = q
            .page_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out: Vec<(u64, Value)> = Vec::new();
        for page_id in pages {
            for v in versions_of(&*read, page_id)? {
                if i64::try_from(v.id).is_ok_and(|id| id > q.after_id) {
                    let mut row = content_json(&v);
                    let fields = row.as_object_mut().expect("content_json builds an object");
                    fields.insert("id".into(), json!(v.id));
                    fields.insert("page_id".into(), json!(page_id));
                    fields.insert(
                        "write_request_id".into(),
                        json!(v.receipt.written.request_id),
                    );
                    out.push((v.id, row));
                }
            }
        }
        out.sort_by_key(|(id, _)| *id);
        Ok(out.into_iter().map(|(_, row)| row).collect())
    }

    /// The named pages (live or not) with their revision, the request that wrote it, their content and tags.
    pub fn list_overwrite_live_pages(&self, q: &VersionsAfterQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pages: BTreeSet<u64> = q
            .page_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for page_id in pages {
            let Some(p) = read_page_by_id(&*read, page_id)? else {
                continue;
            };
            let mut tags = p.tags.clone();
            tags.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push(json!({
                "page_id": p.id,
                "revision": p.knowledge_revision,
                "revision_write_request_id": p.revision_receipt.request_id,
                "body_storage": if p.compiled_truth.is_null() { "segmented" } else { "inline" },
                "title": p.title,
                "type": p.page_type,
                "compiled_truth": p.compiled_truth.as_deref(),
                "timeline": p.timeline.as_deref(),
                "frontmatter": Value::Object(p.frontmatter.clone()),
                "tags": tags,
            }));
        }
        Ok(out)
    }

    /// The newest version of page `pageId` that request `receiptId` archived: `{ id, body_storage, compiled_truth,
    /// timeline }`, or none.
    pub fn read_archived_version_body(&self, q: &ArchivedBodyQuery) -> Result<Option<Value>> {
        no_nul("readArchivedVersionBody", &[("receiptId", &q.receipt_id)])?;
        let Ok(page_id) = u64::try_from(q.page_id) else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(versions_of(&*read, page_id)?
            .into_iter()
            .filter(|v| v.receipt.archived.request_id.as_deref() == Some(q.receipt_id.as_str()))
            .max_by_key(|v| v.id)
            .map(|v| {
                json!({
                    "id": v.id,
                    "body_storage": v.body_storage.clone().unwrap_or_else(|| "inline".into()),
                    "compiled_truth": v.compiled_truth.as_deref(),
                    "timeline": v.timeline.as_deref(),
                })
            }))
    }

    /// `movePageVersions(fromPageId, toPageId)` (the moved-pages fold): every version of page `from`
    /// moves to page `to` (key and `page_id`), as `UPDATE page_versions SET page_id=$2 WHERE
    /// page_id=$1`; the moved ids in id order. A missing `to` page refuses as the foreign key does when
    /// a version would move; a page with no versions moves nothing.
    pub fn move_page_versions(&self, from_page_id: i64, to_page_id: i64) -> Result<Vec<u64>> {
        let (Ok(from), Ok(to)) = (u64::try_from(from_page_id), u64::try_from(to_page_id)) else {
            return Ok(Vec::new());
        };
        self.write(|tx| {
            let versions = versions_of(&*tx, from)?;
            if versions.is_empty() || from == to {
                return Ok(versions.iter().map(|v| v.id).collect());
            }
            if read_page_by_id(&*tx, to)?.is_none() {
                return Err(crate::error::StoreError::new(
                    crate::error::CONSTRAINT_VIOLATION,
                    format!("insert or update on table \"page_versions\" violates foreign key constraint \"page_versions_page_id_fkey\": page {to} is not present"),
                ));
            }
            let mut ids = Vec::with_capacity(versions.len());
            for mut v in versions {
                tx.delete(&keys::version(from, v.id))?;
                v.page_id = to;
                put_json(tx, &keys::version(to, v.id), &v)?;
                ids.push(v.id);
            }
            ids.sort_unstable();
            Ok(ids)
        })
    }

    /// `listInlineVersionTexts(pageId)`: `[{ id, compiled_truth, timeline }]` of the page's versions with an inline
    /// body, by id (`gbrain repair lost-fence-rows`).
    pub fn list_inline_version_texts(&self, page_id: i64) -> Result<Vec<Value>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(versions_of(&*read, page_id)?
            .into_iter()
            .filter_map(|v| {
                v.compiled_truth.as_deref().map(|body| {
                    json!({ "id": v.id, "compiled_truth": body, "timeline": v.timeline.as_deref() })
                })
            })
            .collect())
    }

    /// The content of version `versionId` of page `pageId`, or none.
    pub fn read_version_content(&self, q: &VersionContentQuery) -> Result<Option<Value>> {
        let (Ok(page_id), Ok(version_id)) = (u64::try_from(q.page_id), u64::try_from(q.version_id))
        else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(versions_of(&*read, page_id)?
            .into_iter()
            .find(|v| v.id == version_id)
            .map(|v| content_json(&v)))
    }
}

/// `listOverwriteCandidates({ sourceId, slugs, limit })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct OverwriteCandidateQuery {
    pub source_id: String,
    /// `None` is every live page of the source.
    pub slugs: Option<Vec<String>>,
    pub limit: i64,
}

/// `listVersionsAfter({ pageIds, afterId })` and, without `afterId`, `listOverwriteLivePages({ pageIds })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionsAfterQuery {
    pub page_ids: Vec<i64>,
    pub after_id: i64,
}

/// `readVersionContent({ versionId, pageId })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionContentQuery {
    pub version_id: i64,
    pub page_id: i64,
}

/// The request row with id `id`.
fn request_by_id(read: &dyn KvRead, id: &str) -> Result<Option<RequestRecord>> {
    if id.contains('\0') {
        return Ok(None);
    }
    get_json(read, &keys::request(id))
}

/// SQL's `->>`: a string's text, any other JSON value's text, none for JSON null or a missing key.
fn json_text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// `MANAGED_IMPORT`: intent kind `managed_sync_import`, or a compacted receipt (no intent) of an imported file that is
/// not a connector database write.
fn managed_import(r: &RequestRecord) -> bool {
    let outcome = r.outcome.as_ref();
    json_text(r.intent.get("kind")).as_deref() == Some("managed_sync_import")
        || (r.intent.is_null()
            && json_text(outcome.and_then(|o| o.get("imported_file"))).as_deref() == Some("true")
            && !outcome.is_some_and(|o| o.get("connector_database").is_some()))
}

/// The writer of a lost revision: a committed request of the source that is not an import, whose outcome says it wrote
/// the database only (or carries no persistence outcome and wrote no file through), and that is no read-only mirror
/// write or database-only storage write.
fn database_write(w: &RequestRecord, source_id: &str) -> bool {
    let outcome = w.outcome.as_ref();
    let text = |path: &str| json_text(outcome.and_then(|o| o.pointer(path)));
    let imported = text("/imported_file").unwrap_or_default() == "true";
    let mode = text("/persistence/mode");
    let has_persistence = outcome.is_some_and(|o| o.get("persistence").is_some());
    w.state == "committed"
        && w.source_id == source_id
        && !(w.operation == "submit_job" && imported)
        && (mode.as_deref() == Some("database")
            || (!has_persistence
                && text("/write_through/written").unwrap_or_else(|| "false".into()) != "true"))
        && text("/write_through/skipped").unwrap_or_default() != "mirror_read_only"
        && text("/storage").unwrap_or_default() != "database_only"
}

/// A version's content columns: `body_storage`, `title`, `type`, `compiled_truth`, `timeline`, `frontmatter`, `tags`.
fn content_json(v: &VersionRecord) -> Value {
    json!({
        "body_storage": v.body_storage.clone().unwrap_or_else(|| "inline".into()),
        "title": v.title,
        "type": v.page_type,
        "compiled_truth": v.compiled_truth.as_deref(),
        "timeline": v.timeline.as_deref(),
        "frontmatter": Value::Object(v.frontmatter.clone()),
        "tags": v.tags,
    })
}

/// `readArchivedVersionBody({ pageId, receiptId })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivedBodyQuery {
    pub page_id: i64,
    pub receipt_id: String,
}
