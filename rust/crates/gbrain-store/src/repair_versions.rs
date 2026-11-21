//! The `page_versions` reads and writes of the batch 6 repair kinds (src/core/engine-sql/version-reasons.ts).
//!
//! - `listVersionsByChangeReason` / `replaceVersionChangeReasons`: `gbrain repair purged-change-reasons` lists the
//!   versions of a source's pages whose stored change reason is one of the purged texts, and its apply replaces each
//!   approved reason only while the version still holds the text the apply found.
//! - `listRetainedVersionBodies`: `gbrain repair redacted-facts` reads the newest retained inline bodies of a page
//!   (a segmented snapshot keeps no body copy and is skipped), newest first, at most `limit`.
//!
//! A source's versions are the versions of every page row of the source, live or soft-deleted, as the SQL's join
//! on `pages` reads them.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use crate::Store;
use crate::error::Result;
use crate::keys;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::{PageRecord, all_pages, versions_of};
use crate::put_json;

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
        out.sort_by(|a, b| b.id.cmp(&a.id));
        out.truncate(limit);
        Ok(out)
    }
}
