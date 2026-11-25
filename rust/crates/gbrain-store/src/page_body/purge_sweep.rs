//! The segment storage of a page purge's delete (`deletePageWithSegments`, SQL in src/core/engine-sql/page-purge-sweep.ts):
//! the shas the page's manifest and stagings name, the manifest count, the delete of the page's stagings, the delete of the
//! texts they leave unreferenced, and the claim sweep over the source's other unreferenced texts.
//!
//! A text is needed while a manifest row of any page names it (the manifest's text foreign key) or a live staging recorded it
//! (`stagingNeedsTextSql`): a staging in a live state, or one an outstanding request names in `intent.body_ref.staging_id`
//! (`live_staging_ids`). A staging that no longer exists protects nothing. The claim sweep reads each text as the SQL does,
//! `lower(convert_from(body, 'UTF8'))` (a text that is not UTF-8 refuses), and tests it against the lowered claim forms.
//! Members: `listPageSegmentShas`, `countPageManifestRows`, `deletePageStagings`, `deletePageSegmentTexts`,
//! `sweepPageTextsForClaims`.

use super::{
    MANIFEST, ManifestRow, STAGING, StagingRecord, TEXT, TextRecord, collect, delete_staging,
    from_hex, kind_key, live_staging_ids, manifest_rows, staging_text_prefix, text_key, to_hex,
};
use crate::cli_reads::pg_text::pg_lower;
use crate::journal::request_held_staging_ids;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::{Result, Store, StoreError};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

/// `ORDER BY t.sha256 LIMIT 4096` of one claim-sweep statement.
const CLAIM_SWEEP_ROWS: usize = 4096;

/// The page id of a SQL `integer` argument: a negative id names no page.
fn page_u64(page_id: i64) -> Option<u64> {
    u64::try_from(page_id).ok()
}

/// The stagings of the source filed under `slug` or `page_id`.
fn page_stagings(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
    page_id: i64,
) -> Result<Vec<StagingRecord>> {
    let page = page_u64(page_id);
    Ok(collect::<StagingRecord>(read, &kind_key(STAGING))?
        .into_iter()
        .map(|(_, s)| s)
        .filter(|s| {
            s.source_id == source_id && (s.slug == slug || (page.is_some() && s.page_id == page))
        })
        .collect())
}

/// `(source_id, sha256 hex)` of every text a manifest row names, on any page.
pub(super) fn named_texts(read: &dyn KvRead) -> Result<HashSet<(String, String)>> {
    Ok(collect::<ManifestRow>(read, &kind_key(MANIFEST))?
        .into_iter()
        .map(|(_, row)| (row.source_id, row.sha256.to_lowercase()))
        .collect())
}

/// `(source_id, sha256 hex)` of every text a live staging recorded.
pub(super) fn recorded_by_live(read: &dyn KvRead) -> Result<HashSet<(String, String)>> {
    let live = live_staging_ids(read, &request_held_staging_ids(read)?)?;
    let mut out = HashSet::new();
    for (_, staging) in collect::<StagingRecord>(read, &kind_key(STAGING))? {
        if !live.contains(&staging.id) {
            continue;
        }
        let prefix = staging_text_prefix(&staging.id);
        for (key, text_source) in collect::<String>(read, &prefix)? {
            out.insert((text_source, to_hex(&key[prefix.len()..])));
        }
    }
    Ok(out)
}

impl Store {
    /// `listPageSegmentShas`: the sha256 (hex) of every text a manifest row of the page names or a staging of the source under the
    /// slug or the page recorded for the source, once each, in byte order.
    pub fn list_page_segment_shas(
        &self,
        source_id: &str,
        slug: &str,
        page_id: i64,
    ) -> Result<Vec<String>> {
        no_nul(
            "listPageSegmentShas",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let mut shas = BTreeSet::new();
        if let Some(page) = page_u64(page_id) {
            for (_, row) in manifest_rows(&*read, page)? {
                shas.insert(row.sha256.to_lowercase());
            }
        }
        for staging in page_stagings(&*read, source_id, slug, page_id)? {
            let prefix = staging_text_prefix(&staging.id);
            for (key, text_source) in collect::<String>(&*read, &prefix)? {
                if text_source == source_id {
                    shas.insert(to_hex(&key[prefix.len()..]));
                }
            }
        }
        Ok(shas.into_iter().collect())
    }

    /// `countPageManifestRows`: how many manifest rows the page has, staged rows included.
    pub fn count_page_manifest_rows(&self, page_id: i64) -> Result<u64> {
        let read = self.read()?;
        Ok(match page_u64(page_id) {
            Some(page) => manifest_rows(&*read, page)?.len() as u64,
            None => 0,
        })
    }

    /// `deletePageStagings`: deletes the source's stagings under the slug or the page with their client keys, recorded texts and
    /// page index entries; how many.
    pub fn delete_page_stagings(&self, source_id: &str, slug: &str, page_id: i64) -> Result<u64> {
        no_nul(
            "deletePageStagings",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        self.write(|tx| {
            let doomed = page_stagings(&*tx, source_id, slug, page_id)?;
            for staging in &doomed {
                delete_staging(tx, staging)?;
            }
            Ok(doomed.len() as u64)
        })
    }

    /// `deletePageSegmentTexts`: deletes the source's texts among `shas` (hex) that no manifest row names and no live staging
    /// recorded; how many.
    pub fn delete_page_segment_texts(&self, source_id: &str, shas: &[String]) -> Result<u64> {
        no_nul("deletePageSegmentTexts", &[("sourceId", source_id)])?;
        let mut wanted = BTreeSet::new();
        for sha in shas {
            wanted.insert(from_hex(sha, "deletePageSegmentTexts sha256")?);
        }
        self.write(|tx| {
            let named = named_texts(&*tx)?;
            let recorded = recorded_by_live(&*tx)?;
            let mut deleted = 0;
            for sha in &wanted {
                let id = (source_id.to_string(), to_hex(sha));
                if named.contains(&id) || recorded.contains(&id) {
                    continue;
                }
                let key = text_key(source_id, sha);
                if tx.get(&key)?.is_some() {
                    tx.delete(&key)?;
                    deleted += 1;
                }
            }
            Ok(deleted)
        })
    }

    /// `sweepPageTextsForClaims`: one statement of the claim sweep. Reads the source's texts no manifest row names, after
    /// `cursor` (a sha256 as hex, empty for the start) in sha order, 4096 at most, keeps those whose preceding bytes are under
    /// `chunk_bytes`, and deletes the ones holding one of `forms` that no live staging recorded. `{ last, deleted }`: the
    /// greatest sha (hex) of the chunk, null for an empty one, and the deleted shas in byte order.
    pub fn sweep_page_texts_for_claims(
        &self,
        source_id: &str,
        cursor: &str,
        forms: &[String],
        chunk_bytes: i64,
    ) -> Result<Value> {
        let op = "sweepPageTextsForClaims";
        no_nul(op, &[("sourceId", source_id)])?;
        for form in forms {
            no_nul(op, &[("forms", form)])?;
        }
        let after = from_hex(cursor, "sweepPageTextsForClaims cursor")?;
        self.write(|tx| {
            let named = named_texts(&*tx)?;
            let mut prefix = kind_key(TEXT);
            prefix.extend_from_slice(source_id.as_bytes());
            prefix.push(0);
            // `ORDER BY t.sha256 LIMIT 4096`: the key order is the sha order.
            let mut chunk: Vec<(Vec<u8>, String, TextRecord)> = Vec::new();
            let mut running = 0i64;
            for (key, text) in collect::<TextRecord>(&*tx, &prefix)? {
                let sha = key[prefix.len()..].to_vec();
                let hex = to_hex(&sha);
                if sha <= after || named.contains(&(source_id.to_string(), hex.clone())) {
                    continue;
                }
                if chunk.len() == CLAIM_SWEEP_ROWS {
                    break;
                }
                // `sum(byte_len) OVER (ORDER BY sha256) - byte_len`: the bytes before this text. The sum only grows, so the
                // first text at or past `chunk_bytes` ends the chunk.
                let before = running;
                running += text.byte_len;
                if before >= chunk_bytes {
                    break;
                }
                chunk.push((key, hex, text));
            }
            let last = chunk.last().map(|(_, hex, _)| hex.clone());
            let recorded = recorded_by_live(&*tx)?;
            let mut deleted = Vec::new();
            for (key, hex, text) in &chunk {
                let bytes = from_hex(&text.body, "segment body")?;
                let decoded = String::from_utf8(bytes).map_err(|_| {
                    StoreError::invalid("invalid byte sequence for encoding \"UTF8\"".to_string())
                })?;
                let lowered = pg_lower(&decoded);
                if forms.iter().any(|form| lowered.contains(form.as_str()))
                    && !recorded.contains(&(source_id.to_string(), hex.clone()))
                {
                    deleted.push((key.clone(), hex.clone()));
                }
            }
            for (key, _) in &deleted {
                tx.delete(key)?;
            }
            let mut shas: Vec<String> = deleted.into_iter().map(|(_, hex)| hex).collect();
            shas.sort();
            Ok(json!({ "last": last, "deleted": shas }))
        })
    }
}
