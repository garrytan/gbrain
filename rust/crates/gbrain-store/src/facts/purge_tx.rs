//! The fact purge's transaction statements (src/core/engine-sql/facts-purge.ts, `submitPurgeFactMutation` and
//! `rewritePageBodies` in src/core/facts/purge.ts) that read and delete facts, takes and pages by id:
//!
//! - `listPurgeStreamSlugs(factIds)`: the distinct `COALESCE(source_markdown_slug, entity_slug)` of the named facts of
//!   any source, a NULL left out. The SQL has no `ORDER BY`; the answer is in byte order.
//! - `deletePurgedFacts(factIds, sourceId)`: deletes the named facts of the source; how many.
//! - `listPurgedPageRevisions(sourceId, pageIds)`: `{ id, slug, knowledge_revision }` of the named pages of the source,
//!   deleted pages included, by slug (bytes, as the deterministic collation orders it).
//! - `listPagesForPurgeRewrite(sourceId, pageIds)`: the same pages as whole page rows, each with its tags (sorted) as
//!   `purge_tags`, by slug.
//! - `deletePurgedTakes(takeIds)`: deletes the named takes with their evidence rows; how many.
//!
//! A fact delete runs through [`delete_fact`], which also clears `superseded_by` on the rows that named the fact
//! (`ON DELETE SET NULL`). An id that is not a whole number is refused, as a `bigint[]` / `int[]` bind refuses it.

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{bigint, read_fact};
use crate::Store;
use crate::error::Result;
use crate::pages::{PageRecord, read_page_by_id};
use crate::takes::read_take;

/// `listPurgeStreamSlugs({ factIds })` and `deletePurgedTakes({ takeIds })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeIdsArgs {
    pub ids: Vec<f64>,
}

/// `deletePurgedFacts({ sourceId, ids })`, `listPurgedPageRevisions` and `listPagesForPurgeRewrite`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeSourceIdsArgs {
    pub source_id: String,
    pub ids: Vec<f64>,
}

/// The distinct whole ids of `ids`; a non-positive id names no row.
fn ids_of(op: &str, ids: &[f64]) -> Result<BTreeSet<u64>> {
    let mut out = BTreeSet::new();
    for id in ids {
        if let Ok(id) = u64::try_from(bigint(op, "ids", *id)?) {
            out.insert(id);
        }
    }
    Ok(out)
}

impl Store {
    /// The named pages of the source, deleted or not, by slug bytes.
    fn purge_pages(&self, op: &str, a: &PurgeSourceIdsArgs) -> Result<Vec<PageRecord>> {
        let ids = ids_of(op, &a.ids)?;
        let read = self.read()?;
        let mut pages = Vec::new();
        for id in ids {
            if let Some(page) = read_page_by_id(&*read, id)?
                && page.source_id == a.source_id
            {
                pages.push(page);
            }
        }
        pages.sort_by(|x, y| x.slug.as_bytes().cmp(y.slug.as_bytes()));
        Ok(pages)
    }

    /// `listPurgeStreamSlugs(factIds)`.
    pub fn list_purge_stream_slugs(&self, a: &PurgeIdsArgs) -> Result<Vec<String>> {
        let ids = ids_of("listPurgeStreamSlugs", &a.ids)?;
        let read = self.read()?;
        let mut slugs = BTreeSet::new();
        for id in ids {
            if let Some(row) = read_fact(&*read, id)?
                && let Some(slug) = row.source_markdown_slug.or(row.entity_slug)
            {
                slugs.insert(slug);
            }
        }
        let mut out: Vec<String> = slugs.into_iter().collect();
        out.sort_by(|x, y| x.as_bytes().cmp(y.as_bytes()));
        Ok(out)
    }

    /// `listPurgedPageRevisions(sourceId, pageIds)`.
    pub fn list_purged_page_revisions(&self, a: &PurgeSourceIdsArgs) -> Result<Vec<Value>> {
        Ok(self
            .purge_pages("listPurgedPageRevisions", a)?
            .into_iter()
            .map(|p| json!({ "id": p.id, "slug": p.slug, "knowledge_revision": p.knowledge_revision }))
            .collect())
    }
}

/// `deletePurgeTrustProposals({ sourceId, factIds, takeIds })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeProposalsArgs {
    pub source_id: String,
    pub fact_ids: Vec<f64>,
    pub take_ids: Vec<f64>,
}

/// `deletePurgeWriteGateHolds({ sourceId, factHash })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeHoldsArgs {
    pub source_id: String,
    pub fact_hash: String,
}

/// `deletePurgeWriteGateReceipts({ factIds, takeIds, holdIds })`: ids as text, as the `text[]` binds compare them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeReceiptsArgs {
    pub fact_ids: Vec<String>,
    pub take_ids: Vec<String>,
    pub hold_ids: Vec<String>,
}

impl Store {}

/// `updatePageBodyForPurge({ sourceId, pageId, compiled, timeline, hash })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgePageBodyArgs {
    pub source_id: String,
    pub page_id: f64,
    pub compiled: String,
    pub timeline: String,
    pub hash: String,
}

/// `setPurgeVersionBody({ versionId, compiled, timeline })`: a null timeline stays null.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeVersionBodyArgs {
    pub version_id: f64,
    pub compiled: String,
    pub timeline: Option<String>,
}

/// `redactVersionChangeReasons({ sourceId, needle, reasonNeedle })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactReasonsArgs {
    pub source_id: String,
    pub needle: String,
    pub reason_needle: String,
}

/// The CHECK a body write on a segmented row fails.
fn check_failed(relation: &str, constraint: &str) -> crate::error::StoreError {
    crate::error::StoreError::new(
        crate::error::CONSTRAINT_VIOLATION,
        format!("new row for relation \"{relation}\" violates check constraint \"{constraint}\""),
    )
}

impl Store {
    /// `setPurgeVersionBody`: `UPDATE page_versions SET compiled_truth, timeline WHERE id`. A segmented snapshot fails
    /// `page_versions_body_chk`, as the SQL does.
    pub fn set_purge_version_body(&self, a: &PurgeVersionBodyArgs) -> Result<()> {
        const OP: &str = "setPurgeVersionBody";
        let Ok(version_id) = u64::try_from(bigint(OP, "versionId", a.version_id)?) else {
            return Ok(());
        };
        crate::links::no_nul(OP, &[("compiled", a.compiled.as_str())])?;
        if let Some(t) = &a.timeline {
            crate::links::no_nul(OP, &[("timeline", t.as_str())])?;
        }
        self.write(|tx| {
            let Some(mut version) = crate::trust::tier_reads::all_versions(&*tx)?
                .into_iter()
                .find(|v| v.id == version_id)
            else {
                return Ok(());
            };
            if version.body_storage.as_deref() == Some("segmented") {
                return Err(check_failed("page_versions", "page_versions_body_chk"));
            }
            version.compiled_truth = a.compiled.as_str().into();
            version.timeline = a
                .timeline
                .clone()
                .map_or_else(crate::pages::PageText::null, Into::into);
            crate::put_json(
                tx,
                &crate::keys::version(version.page_id, version.id),
                &version,
            )
        })
    }

    /// `redactVersionChangeReasons`: sets `change_reason = '[purged]'` on every version of a page of the source whose
    /// lowered reason contains `needle` or `reasonNeedle`; the ids, in id order (the SQL's RETURNING has no order).
    pub fn redact_version_change_reasons(&self, a: &RedactReasonsArgs) -> Result<Vec<u64>> {
        crate::links::no_nul(
            "redactVersionChangeReasons",
            &[
                ("needle", a.needle.as_str()),
                ("reasonNeedle", a.reason_needle.as_str()),
            ],
        )?;
        self.write(|tx| {
            let mut redacted = Vec::new();
            for mut version in crate::trust::tier_reads::all_versions(&*tx)? {
                let Some(reason) = version.change_reason.as_deref() else {
                    continue;
                };
                let lowered = reason.to_lowercase();
                if !lowered.contains(a.needle.as_str())
                    && !lowered.contains(a.reason_needle.as_str())
                {
                    continue;
                }
                if !read_page_by_id(&*tx, version.page_id)?
                    .is_some_and(|p| p.source_id == a.source_id)
                {
                    continue;
                }
                version.change_reason = Some("[purged]".to_string());
                crate::put_json(
                    tx,
                    &crate::keys::version(version.page_id, version.id),
                    &version,
                )?;
                redacted.push(version.id);
            }
            redacted.sort_unstable();
            Ok(redacted)
        })
    }
}

impl Store {
    /// `expireDerivedFacts(ids, sourceId)`: `UPDATE facts SET expired_at = COALESCE(expired_at, now()) WHERE id = ANY AND
    /// source_id RETURNING id`; how many rows it touched (an already expired fact counts and keeps its time).
    pub fn expire_derived_facts(&self, a: &PurgeSourceIdsArgs) -> Result<u64> {
        let ids = ids_of("expireDerivedFacts", &a.ids)?;
        if ids.is_empty() {
            return Ok(0);
        }
        let trust = &self.write_trust()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut touched = 0;
            for &id in &ids {
                if let Some(old) = read_fact(&*tx, id)?
                    && old.source_id == a.source_id
                {
                    let mut new = old.clone();
                    new.expired_at_us = Some(old.expired_at_us.unwrap_or(now));
                    super::write_fact(tx, trust, Some(&old), &new)?;
                    touched += 1;
                }
            }
            Ok(touched)
        })
    }

    /// `deactivateDerivedTakes(ids, sourceId)`: `UPDATE takes k SET active = false FROM pages p WHERE k.id = ANY AND
    /// p.id = k.page_id AND p.source_id RETURNING k.id`; how many rows it touched (an inactive take counts).
    pub fn deactivate_derived_takes(&self, a: &PurgeSourceIdsArgs) -> Result<u64> {
        let ids = ids_of("deactivateDerivedTakes", &a.ids)?;
        if ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let mut touched = 0;
            for &id in &ids {
                let Some(mut take) = read_take(&*tx, id)? else {
                    continue;
                };
                if !read_page_by_id(&*tx, take.page_id)?.is_some_and(|p| p.source_id == a.source_id)
                {
                    continue;
                }
                take.active = false;
                crate::takes::store_take(tx, &take)?;
                touched += 1;
            }
            Ok(touched)
        })
    }

    /// `softDeleteDerivedPages(ids, sourceId)`: soft-deletes the named live pages of the source and answers one row per
    /// named page of the source that is now hidden: `{ id, now: true }` for each page this call hid, then
    /// `{ id, now: false }` for each that was already deleted, each group in id order (the SQL's `UNION ALL` of two
    /// `RETURNING` sets has no order within a group).
    pub fn soft_delete_derived_pages(&self, a: &PurgeSourceIdsArgs) -> Result<Vec<Value>> {
        let ids = ids_of("softDeleteDerivedPages", &a.ids)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let (mut hid, mut gone) = (Vec::new(), Vec::new());
            for &id in &ids {
                let Some(mut page) = read_page_by_id(&*tx, id)? else {
                    continue;
                };
                if page.source_id != a.source_id {
                    continue;
                }
                if page.deleted_at_us.is_some() {
                    gone.push(json!({ "id": id, "now": false }));
                } else {
                    page.deleted_at_us = Some(now);
                    crate::page_ops::write_changed(tx, &*self.env, &mut page)?;
                    hid.push(json!({ "id": id, "now": true }));
                }
            }
            hid.extend(gone);
            Ok(hid)
        })
    }
}
