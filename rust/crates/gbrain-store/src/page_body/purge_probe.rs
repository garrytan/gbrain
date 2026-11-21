//! A page purge receipt's probes of the segment texts (`countPurgeStoreProbe`, kinds `page_segment_texts` and
//! `segment_texts`; the SQL is `purgeStoreProbeSelect`, src/core/engine-sql/purge-verify.ts). Read only.
//!
//! A text is named by a manifest row of any page of its source (`named_texts`) and needed by a live staging that recorded it
//! (`recorded_by_live`), as in the purge's own sweep (purge_sweep.rs). The page probe finds an unnamed, unneeded text that
//! has one of the page's shas or holds one of its lowered forms (the stored bytes decoded as UTF-8, then lowered; a text
//! that is not UTF-8 refuses, as `convert_from` does). The text probe finds the texts that hold a needle byte for byte,
//! named or not as asked.

use super::purge_sweep::{named_texts, recorded_by_live};
use super::{TEXT, TextRecord, from_hex, kind_key, to_hex};
use crate::cli_reads::pg_text::pg_lower;
use crate::kv::{KvRead, scan_prefix};
use crate::{Result, StoreError};
use std::collections::HashSet;

/// Calls `f` with each text of the source (its sha as hex and its record), in sha order, until it returns false or fails. A
/// record is read when the scan reaches it, so a stop leaves the later texts, bodies included, unread.
fn for_each_source_text(
    read: &dyn KvRead,
    source_id: &str,
    f: &mut dyn FnMut(String, TextRecord) -> Result<bool>,
) -> Result<()> {
    let mut prefix = kind_key(TEXT);
    prefix.extend_from_slice(source_id.as_bytes());
    prefix.push(0);
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |key, value| {
        let step = serde_json::from_slice::<TextRecord>(value)
            .map_err(StoreError::from)
            .and_then(|text| f(to_hex(&key[prefix.len()..]), text));
        match step {
            Ok(more) => more,
            Err(e) => {
                failure = Some(e);
                false
            }
        }
    })?;
    failure.map_or(Ok(()), Err)
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
    for_each_source_text(read, source_id, &mut |hex, text| {
        let key = (source_id.to_string(), hex);
        if named.contains(&key) || recorded.contains(&key) {
            return Ok(true);
        }
        let hit = if wanted.contains(&key.1) {
            true
        } else if forms.is_empty() {
            false
        } else {
            let decoded = String::from_utf8(body(&text)?).map_err(|_| {
                StoreError::invalid("invalid byte sequence for encoding \"UTF8\"".to_string())
            })?;
            let lowered = pg_lower(&decoded);
            forms.iter().any(|f| lowered.contains(f.as_str()))
        };
        count += usize::from(hit);
        Ok(count < cap)
    })?;
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
    for_each_source_text(read, source_id, &mut |hex, text| {
        if named.contains(&(source_id.to_string(), hex)) != referenced {
            return Ok(true);
        }
        let bytes = body(&text)?;
        if needles.iter().any(|n| has_bytes(&bytes, n)) {
            count += 1;
        }
        Ok(count < cap)
    })?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kv::counting::Counting;

    fn text(source: &str, n: usize, body: &str) -> (Vec<u8>, Vec<u8>) {
        let mut key = kind_key(TEXT);
        key.extend_from_slice(source.as_bytes());
        key.push(0);
        key.extend_from_slice(&[0, 0, 0, n as u8]);
        let record = TextRecord {
            byte_len: body.len() as i64,
            line_count: 1,
            body: to_hex(body.as_bytes()),
            created_at_us: 0,
        };
        (key, serde_json::to_vec(&record).unwrap())
    }

    #[test]
    fn the_text_scans_stop_at_the_cap_and_read_no_later_text() {
        let mut store = Counting::default();
        store
            .entries
            .extend((1..=30).map(|n| text("default", n, "holds notes/doomed here")));
        store
            .entries
            .extend([text("other", 1, "holds notes/doomed here")]);
        let forms = vec!["notes/doomed".to_string()];
        let page = |cap| {
            store.delivered.set(0);
            let found = count_page_texts(&store, "default", &[], &forms, cap).unwrap();
            (found, store.delivered.get())
        };
        let holding = |cap| {
            store.delivered.set(0);
            let found = count_texts_holding(&store, "default", &forms, false, cap).unwrap();
            (found, store.delivered.get())
        };
        // (matches, text records handed out): the scan ends at the cap'th match, and another source's text is never reached.
        assert_eq!(page(1), (1, 1));
        assert_eq!(page(5), (5, 5));
        assert_eq!(holding(1), (1, 1));
        assert_eq!(holding(7), (7, 7));
        assert_eq!(page(500).0, 30);
        assert_eq!(holding(500).0, 30);
    }

    #[test]
    fn a_text_that_is_not_utf8_still_refuses_the_page_form_scan() {
        let mut store = Counting::default();
        let (key, mut value) = text("default", 1, "x");
        let mut record: TextRecord = serde_json::from_slice(&value).unwrap();
        record.body = to_hex(&[0xFF, 0xFE]);
        value = serde_json::to_vec(&record).unwrap();
        store.entries.insert(key, value);
        let forms = vec!["x".to_string()];
        assert!(count_page_texts(&store, "default", &[], &forms, 3).is_err());
    }
}
