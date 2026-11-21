//! `listPurgeVersionBodies`: the fact purge's read of saved inline version bodies
//! (`src/core/engine-sql/segmented-purge-writes.ts` `PURGE_VERSION_BODY_SQL`, which
//! `facts/purge.ts` `redactPageVersions` reads in keyset batches).
//!
//! PGLite's statement:
//!
//! ```sql
//! SELECT v.id,p.slug,v.compiled_truth,v.timeline,
//!   (strpos(lower(COALESCE(v.title,'')),$4)>0 OR strpos(lower(COALESCE(v.frontmatter::text,'')),$5)>0) AS metadata
//!   FROM page_versions v JOIN pages p ON p.id=v.page_id
//!   WHERE p.source_id=$1 AND v.body_storage='inline' AND v.id>$3
//!     AND (v.page_id=ANY($2::int[]) OR <the claim in compiled_truth, timeline, title or frontmatter>)
//!   ORDER BY v.id LIMIT 5000
//! ```
//!
//! `lower` is the database's per-character lowering (`cli_reads::pg_text::pg_lower`), `strpos(x, n) > 0`
//! is a substring test (an empty needle is in every text), and `frontmatter::text` is jsonb's text form
//! (`cli_reads::pg_text::jsonb_text`). A NULL compiled_truth holds no needle, as `strpos(NULL, n) > 0` is
//! NULL. Soft-deleted pages count: the join does not filter them.

use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::kv::scan_prefix;
use crate::pages::{PageRecord, versions_of};
use crate::{Result, Store, StoreError, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

/// `VERSION_BODY_BATCH`: the rows one read returns.
const VERSION_BODY_BATCH: usize = 5000;

/// `listPurgeVersionBodies`' argument (`PurgeVersionBodyQuery`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PurgeVersionBodyQuery {
    pub source_id: String,
    pub page_ids: Vec<i64>,
    pub after: i64,
    /// The claim, lowercased.
    pub needle: String,
    /// The claim as it reads in a lowercased frontmatter JSON text.
    pub escaped: String,
}

/// `strpos(lower(text), needle) > 0`.
fn holds(text: &str, needle: &str) -> bool {
    pg_lower(text).contains(needle)
}

impl Store {
    /// `listPurgeVersionBodies({ sourceId, pageIds, after, needle, escaped })`: one batch of the source's
    /// inline versions of `pageIds` or carrying the claim, in id order after `after`, as
    /// `{ id, slug, compiled_truth, timeline, metadata }`.
    pub fn list_purge_version_bodies(&self, query: &PurgeVersionBodyQuery) -> Result<Vec<Value>> {
        if query.source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let pages_wanted: HashSet<i64> = query.page_ids.iter().copied().collect();
        let read = self.read()?;
        let prefix = keys::text(keys::PAGE, &[query.source_id.as_str(), ""]);
        let mut pages: Vec<PageRecord> = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |_, v| {
            match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => pages.push(page),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut rows: Vec<(u64, Value)> = Vec::new();
        for page in &pages {
            for v in versions_of(&*read, page.id)? {
                if v.body_storage.as_deref().is_some_and(|s| s != "inline")
                    || i64::try_from(v.id).is_ok_and(|id| id <= query.after)
                {
                    continue;
                }
                let title = holds(&v.title, &query.needle);
                let frontmatter = holds(
                    &jsonb_text(&Value::Object(v.frontmatter.clone())),
                    &query.escaped,
                );
                let body = v
                    .compiled_truth
                    .as_deref()
                    .is_some_and(|t| holds(t, &query.needle));
                let timeline = holds(&v.timeline, &query.needle);
                let named = i64::try_from(v.page_id).is_ok_and(|id| pages_wanted.contains(&id));
                if !(named || body || timeline || title || frontmatter) {
                    continue;
                }
                rows.push((
                    v.id,
                    json!({
                        "id": v.id,
                        "slug": page.slug,
                        "compiled_truth": v.compiled_truth.as_deref(),
                        "timeline": v.timeline.as_deref(),
                        "metadata": title || frontmatter,
                    }),
                ));
            }
        }
        rows.sort_by_key(|(id, _)| *id);
        rows.truncate(VERSION_BODY_BATCH);
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    }
}
