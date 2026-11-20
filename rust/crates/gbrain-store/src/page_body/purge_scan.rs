//! The segmented-body reads of a fact purge's plan and dry run (facts/purge_plan.rs): which live
//! stagings hold a claim, whether a segmented version's generation holds it, and which pages are
//! segmented. Read only; the purge's commit and sweep do not run here.
//!
//! Each segment text is matched as PGLite's `strpos(lower(convert_from(t.body,'UTF8')),$n)>0`:
//! the stored bytes decoded as UTF-8 (a text that is not UTF-8 refuses, as `convert_from` does),
//! lowered per character (`pg_lower`), then searched for the lowered needle. The raw upload parts
//! (`page_body_staging_parts`) are not kept by this store, so the part arm never matches.

use super::{
    BodyState, LIVE_STAGING_STATES, MANIFEST, ManifestRow, STAGING, StagingRecord, TextRecord,
    collect, from_hex, in_generation, is_segmented, kind_key, manifest_rows, read_body_state,
    staging_text_prefix, text_key,
};
use crate::cli_reads::pg_text::pg_lower;
use crate::kv::KvRead;
use crate::{Result, StoreError, get_json};
use std::collections::{BTreeSet, HashMap, HashSet};

/// The lowered text of segment `sha256` (hex) of `source_id`, or `None` when no such text exists.
fn lowered_text(
    read: &dyn KvRead,
    cache: &mut HashMap<(String, String), Option<String>>,
    source_id: &str,
    sha256: &str,
) -> Result<Option<String>> {
    let key = (source_id.to_string(), sha256.to_string());
    if let Some(hit) = cache.get(&key) {
        return Ok(hit.clone());
    }
    let sha = from_hex(sha256, "segment sha256")?;
    let found = match get_json::<TextRecord>(read, &text_key(source_id, &sha))? {
        None => None,
        Some(text) => {
            let bytes = from_hex(&text.body, "segment body")?;
            let decoded = String::from_utf8(bytes).map_err(|_| {
                StoreError::invalid("invalid byte sequence for encoding \"UTF8\"".to_string())
            })?;
            Some(pg_lower(&decoded))
        }
    };
    cache.insert(key, found.clone());
    Ok(found)
}

fn holds(text: Option<&str>, needles: &[&str]) -> bool {
    text.is_some_and(|t| needles.iter().any(|n| t.contains(n)))
}

/// `STAGINGS_HOLDING_CLAIM_SQL`: the stagings of `source_id` that hold the lowered claim, by id.
///
/// - A staging in a live state (`open`, `sealed`, `prepared`) holds it when one of its manifest
///   rows names a text that contains `claim_lower`.
/// - A live staging (a live state, or one that `held` names: the stagings an unfinished request
///   publishes) holds it when one of the texts it recorded contains `claim_lower` or `cell_lower`.
pub(crate) fn stagings_holding_claim(
    read: &dyn KvRead,
    source_id: &str,
    claim_lower: &str,
    cell_lower: &str,
    held: &HashSet<String>,
) -> Result<Vec<String>> {
    let mut cache = HashMap::new();
    let stagings: Vec<StagingRecord> = collect::<StagingRecord>(read, &kind_key(STAGING))?
        .into_iter()
        .map(|(_, s)| s)
        .filter(|s| s.source_id == source_id)
        .collect();
    if stagings.is_empty() {
        return Ok(Vec::new());
    }
    let mut by_staging: HashMap<String, Vec<ManifestRow>> = HashMap::new();
    for (_, row) in collect::<ManifestRow>(read, &kind_key(MANIFEST))? {
        if let Some(id) = row.staging_id.clone() {
            by_staging.entry(id).or_default().push(row);
        }
    }
    let mut out = BTreeSet::new();
    for staging in stagings {
        let live_state = LIVE_STAGING_STATES.contains(&staging.state.as_str());
        if live_state {
            for row in by_staging
                .get(&staging.id)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let text = lowered_text(read, &mut cache, &row.source_id, &row.sha256)?;
                if holds(text.as_deref(), &[claim_lower]) {
                    out.insert(staging.id.clone());
                    break;
                }
            }
        }
        if out.contains(&staging.id) || !(live_state || held.contains(&staging.id)) {
            continue;
        }
        let prefix = staging_text_prefix(&staging.id);
        for (key, text_source) in collect::<String>(read, &prefix)? {
            let sha: String = key[prefix.len()..]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let text = lowered_text(read, &mut cache, &text_source, &sha)?;
            if holds(text.as_deref(), &[claim_lower, cell_lower]) {
                out.insert(staging.id.clone());
                break;
            }
        }
    }
    // `ORDER BY s.id`: the uuid order is the order of its lowercase text.
    Ok(out.into_iter().collect())
}

/// `SEGMENTED_VERSION_CARRIES`: a published manifest row of page `page_id` in generation
/// `generation` names a text that contains `claim_lower`.
pub(crate) fn generation_carries(
    read: &dyn KvRead,
    page_id: u64,
    generation: i64,
    claim_lower: &str,
) -> Result<bool> {
    let mut cache = HashMap::new();
    for (_, row) in manifest_rows(read, page_id)? {
        if !in_generation(&row, generation) {
            continue;
        }
        let text = lowered_text(read, &mut cache, &row.source_id, &row.sha256)?;
        if holds(text.as_deref(), &[claim_lower]) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `pages.body_storage = 'segmented'` for page `page_id`.
pub(crate) fn page_is_segmented(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    let state: Option<BodyState> = read_body_state(read, page_id)?;
    Ok(is_segmented(state.as_ref()))
}
