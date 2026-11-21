//! A page purge receipt's probes of the segment texts (`countPurgeStoreProbe`, kinds `page_segment_texts` and
//! `segment_texts`; the SQL is `purgeStoreProbeSelect`, src/core/engine-sql/purge-verify.ts). Read only.
//!
//! A text is named by a manifest row of any page of its source (`named_texts`) and needed by a live staging that recorded it
//! (`recorded_by_live`), as in the purge's own sweep (purge_sweep.rs). The page probe finds an unnamed, unneeded text that
//! has one of the page's shas or holds one of its lowered forms (the stored bytes decoded as UTF-8, then lowered; a text
//! that is not UTF-8 refuses, as `convert_from` does). The text probe finds the texts that hold a needle byte for byte,
//! named or not as asked.

use super::purge_sweep::{named_texts, recorded_by_live};
use super::{TEXT, TextRecord, collect, from_hex, kind_key, to_hex};
use crate::cli_reads::pg_text::pg_lower;
use crate::kv::KvRead;
use crate::{Result, StoreError};
use std::collections::HashSet;

/// The source's texts with their sha as hex, in sha order.
fn source_texts(read: &dyn KvRead, source_id: &str) -> Result<Vec<(String, TextRecord)>> {
    let mut prefix = kind_key(TEXT);
    prefix.extend_from_slice(source_id.as_bytes());
    prefix.push(0);
    Ok(collect::<TextRecord>(read, &prefix)?
        .into_iter()
        .map(|(key, text)| (to_hex(&key[prefix.len()..]), text))
        .collect())
}

fn body(text: &TextRecord) -> Result<Vec<u8>> {
    from_hex(&text.body, "segment body")
}

/// `position(convert_to(needle, 'UTF8') in body) > 0`: an empty needle is found everywhere.
fn has_bytes(body: &[u8], needle: &str) -> bool {
    let needle = needle.as_bytes();
    needle.is_empty() || body.windows(needle.len()).any(|w| w == needle)
}

/// The texts of `source_id` that no manifest row names and no live staging recorded, with the sha (hex) of one of `shas`
/// or holding one of the lowered `forms`; the walk stops at `cap` matches.
pub(crate) fn count_page_texts(
    read: &dyn KvRead,
    source_id: &str,
    shas: &[String],
    forms: &[String],
    cap: usize,
) -> Result<usize> {
    let mut wanted = HashSet::new();
    for sha in shas {
        wanted.insert(to_hex(&from_hex(sha, "segment sha256")?));
    }
    let named = named_texts(read)?;
    let recorded = recorded_by_live(read)?;
    let mut count = 0;
    for (hex, text) in source_texts(read, source_id)? {
        let key = (source_id.to_string(), hex);
        if named.contains(&key) || recorded.contains(&key) {
            continue;
        }
        if wanted.contains(&key.1) {
            count += 1;
            if count >= cap {
                break;
            }
            continue;
        }
        if forms.is_empty() {
            continue;
        }
        let decoded = String::from_utf8(body(&text)?).map_err(|_| {
            StoreError::invalid("invalid byte sequence for encoding \"UTF8\"".to_string())
        })?;
        let lowered = pg_lower(&decoded);
        if forms.iter().any(|f| lowered.contains(f.as_str())) {
            count += 1;
            if count >= cap {
                break;
            }
        }
    }
    Ok(count)
}

/// The texts of `source_id` holding one of `needles` byte for byte that a manifest row names (`referenced`) or none does;
/// the walk stops at `cap` matches.
pub(crate) fn count_texts_holding(
    read: &dyn KvRead,
    source_id: &str,
    needles: &[String],
    referenced: bool,
    cap: usize,
) -> Result<usize> {
    let named = named_texts(read)?;
    let mut count = 0;
    for (hex, text) in source_texts(read, source_id)? {
        if named.contains(&(source_id.to_string(), hex)) != referenced {
            continue;
        }
        let bytes = body(&text)?;
        if needles.iter().any(|n| has_bytes(&bytes, n)) {
            count += 1;
            if count >= cap {
                break;
            }
        }
    }
    Ok(count)
}
