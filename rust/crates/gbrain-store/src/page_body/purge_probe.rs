//! A page purge receipt's probes of the segment texts (`countPurgeStoreProbe`, kinds `page_segment_texts` and
//! `segment_texts`; the SQL is `purgeStoreProbeSelect`, src/core/engine-sql/purge-verify.ts). Read only.
//!
//! A text is named by a manifest row of any page of its source (`named_texts`) and needed by a live staging that recorded it
//! (`recorded_by_live`), as in the purge's own sweep (purge_sweep.rs). The page probe finds an unnamed, unneeded text that
//! has one of the page's shas or holds one of its lowered forms (the stored bytes decoded as UTF-8, then lowered; a text
//! that is not UTF-8 refuses, as `convert_from` does). The text probe finds the texts that hold a needle byte for byte,
//! named or not as asked.

use super::purge_sweep::{named_texts, recorded_by_live};
use super::{
    DERIVATION, DerivationRecord, MANIFEST, ManifestRow, STAGING, STAGING_TEXT, StagingRecord,
    TEXT, TextRecord, derivation_key, from_hex, kind_key, page_u64, signed, to_hex,
};
use crate::Store;
use crate::cli_reads::pg_text::jsonb_text;
use crate::cli_reads::pg_text::pg_lower;
use crate::facts::fact_normalize;
use crate::facts::purge_plan::derivation_fold;
use crate::facts::purge_probe::{EachRow, ProbeCell, ProbeRow, each_json};
use crate::kv::for_each_prefix_paged_from;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page_by_id};
use crate::{Result, StoreError};
use serde::Deserialize;
use serde_json::{Value, json};
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

/// The `page_body_manifest` rows as the table probe of a fact purge's receipt reads them (`facts/purge_probe.rs`), every source's, in
/// key order (the published and the staged rows alike). The hashes read as `bytea` text (`\x` and hex), the JSON columns as `jsonb` text.
pub(crate) fn probe_manifest(read: &dyn KvRead, f: EachRow) -> Result<()> {
    each_json::<ManifestRow>(read, &kind_key(MANIFEST), &mut |_, m| {
        f(ProbeRow {
            source_id: Some(m.source_id.clone()),
            cells: vec![
                ("region", ProbeCell::text(&m.region)),
                ("source_id", ProbeCell::text(&m.source_id)),
                ("sha256", ProbeCell::bytea_hex(&m.sha256)),
                ("cut_kind", ProbeCell::text(&m.cut_kind)),
                ("entry_state", ProbeCell::jsonb(&m.entry_state)),
                ("protected_regions", ProbeCell::jsonb(&m.protected_regions)),
                ("facts_slots", ProbeCell::jsonb(&m.facts_slots)),
                ("outline", ProbeCell::jsonb(&m.outline)),
                ("hash_state", ProbeCell::bytea_hex(&m.hash_state)),
            ],
        })
    })
}

/// The `page_body_stagings` rows as the table probe reads them, every source's, in staging id order.
pub(crate) fn probe_stagings(read: &dyn KvRead, f: EachRow) -> Result<()> {
    each_json::<StagingRecord>(read, &kind_key(STAGING), &mut |_, s| {
        f(ProbeRow {
            source_id: Some(s.source_id.clone()),
            cells: vec![
                ("kind", ProbeCell::text(&s.kind)),
                ("principal_kind", ProbeCell::text(&s.principal_kind)),
                ("principal_id", ProbeCell::text(&s.principal_id)),
                ("source_id", ProbeCell::text(&s.source_id)),
                ("slug", ProbeCell::text(&s.slug)),
                ("mode", ProbeCell::text(&s.mode)),
                (
                    "declared_sha256",
                    ProbeCell::opt_bytea_hex(s.declared_sha256.as_deref()),
                ),
                ("state", ProbeCell::text(&s.state)),
            ],
        })
    })
}

/// The `page_body_staging_texts` rows as the table probe reads them: the key holds the staging id (text) and the text's sha, the value
/// the text's source.
pub(crate) fn probe_staging_texts(read: &dyn KvRead, f: EachRow) -> Result<()> {
    let prefix = kind_key(STAGING_TEXT);
    each_json::<String>(read, &prefix, &mut |key, source_id| {
        let Some(split) = key.len().checked_sub(32).filter(|s| *s >= prefix.len()) else {
            return Ok(true);
        };
        f(ProbeRow {
            source_id: Some(source_id.clone()),
            cells: vec![
                ("source_id", ProbeCell::text(&source_id)),
                ("sha256", ProbeCell::bytea_hex(&to_hex(&key[split..]))),
            ],
        })
    })
}

/// The `page_segment_texts` rows of `source_id` as the table probe reads them: the body is matched byte for byte.
pub(crate) fn probe_texts(read: &dyn KvRead, source_id: &str, f: EachRow) -> Result<()> {
    for_each_source_text(read, source_id, &mut |sha, text| {
        let bytes = body(&text)?;
        f(ProbeRow {
            source_id: Some(source_id.to_string()),
            cells: vec![
                ("source_id", ProbeCell::text(source_id)),
                ("sha256", ProbeCell::bytea_hex(&sha)),
                ("body", ProbeCell::Bytes(bytes)),
            ],
        })
    })
}

/// A derivation's `output` or `receipt` as the table holds it: the writer (`jsonb_to_recordset`) stores an omitted or top-level
/// JSON null as SQL NULL, which matches no needle. A JSON null inside a document stays the text `null`.
fn nullable(value: &Value) -> ProbeCell {
    if value.is_null() {
        ProbeCell::Null
    } else {
        ProbeCell::jsonb(value)
    }
}

/// `COALESCE(col::text, '')` of that column.
pub(super) fn sql_text(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        jsonb_text(value)
    }
}

/// The `page_segment_derivations` rows as the table probe reads them: the table has no `source_id`, so the probe is brain-wide. The
/// pipeline is in the key (after the page id, before the occurrence).
pub(crate) fn probe_derivations(read: &dyn KvRead, f: EachRow) -> Result<()> {
    each_json::<DerivationRecord>(read, &kind_key(DERIVATION), &mut |key, d| {
        let pipeline = key
            .get(10..key.len().saturating_sub(9))
            .map(|k| String::from_utf8_lossy(k).into_owned());
        f(ProbeRow {
            source_id: None,
            cells: vec![
                ("pipeline", ProbeCell::opt_text(pipeline.as_deref())),
                ("segment_sha256", ProbeCell::bytea_hex(&d.segment_sha256)),
                ("context_hash", ProbeCell::bytea_hex(&d.context_hash)),
                ("state", ProbeCell::text(&d.state)),
                ("output", nullable(&d.output)),
                ("receipt", nullable(&d.receipt)),
            ],
        })
    })
}

/// `probePurgeDerivations`' arguments (`derivationTextReport`, src/core/facts/purge-verify.ts): one batch of the stored derivation
/// results of `sourceId` after `cursor`, in (page, pipeline, occurrence) order. `needles` and `patterns` are the claims' forms
/// (`derivationNeedles`), `pageIds` the pages the purge rewrote.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationProbeArgs {
    pub source_id: String,
    pub needles: Vec<String>,
    pub page_ids: Vec<i64>,
    pub patterns: Vec<String>,
    pub cursor: Option<DerivationCursor>,
    pub rows: i64,
}

/// The key of the last row a batch walked.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DerivationCursor {
    pub page: i64,
    pub pipeline: String,
    /// A bigint, as text.
    pub occurrence: String,
}

/// `text LIKE pattern` with the default escape: `%` any run, `_` any one character, a backslash makes the next character literal.
fn like(text: &str, pattern: &str) -> bool {
    #[derive(Clone, Copy)]
    enum Token {
        Run,
        One,
        Lit(char),
    }
    let mut tokens = Vec::new();
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        tokens.push(match c {
            '%' => Token::Run,
            '_' => Token::One,
            '\\' => Token::Lit(chars.next().unwrap_or('\\')),
            c => Token::Lit(c),
        });
    }
    let text: Vec<char> = text.chars().collect();
    let (mut t, mut p, mut star, mut mark) = (0, 0, None, 0);
    while t < text.len() {
        match tokens.get(p) {
            Some(Token::Run) => {
                star = Some(p);
                mark = t;
                p += 1;
            }
            Some(Token::One) => {
                t += 1;
                p += 1;
            }
            Some(Token::Lit(c)) if *c == text[t] => {
                t += 1;
                p += 1;
            }
            _ => match star {
                Some(s) => {
                    mark += 1;
                    t = mark;
                    p = s + 1;
                }
                None => return false,
            },
        }
    }
    while matches!(tokens.get(p), Some(Token::Run)) {
        p += 1;
    }
    p == tokens.len()
}

/// `foldSql(lower(text)) LIKE ANY (patterns)`: the words of a claim occur in the text in the claim's order.
pub(super) fn has_words(text: &str, patterns: &[String]) -> bool {
    let folded = derivation_fold(&pg_lower(text));
    patterns.iter().any(|p| like(&folded, p))
}

/// Every string value and every object key of a JSON document, at any depth (`jsonb_path_query` of `strict $.**`).
fn strings_of(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| strings_of(v, out)),
        Value::Object(map) => {
            for (key, v) in map {
                out.push(key.clone());
                strings_of(v, out);
            }
        }
        _ => {}
    }
}

/// `derivationHoldsClaimSql`: the row's output or receipt holds a claim as whole words of one string value or object key.
pub(super) fn holds_claim(d: &DerivationRecord, needles: &[String], patterns: &[String]) -> bool {
    let mut strings = Vec::new();
    strings_of(&d.output, &mut strings);
    strings_of(&d.receipt, &mut strings);
    strings.iter().any(|t| {
        has_words(t, patterns) && {
            let form = format!(" {} ", derivation_fold(&fact_normalize(t)));
            needles.iter().any(|n| form.contains(n.as_str()))
        }
    })
}

/// `derivationSweepScopeSql`: the row belongs to a page the purge rewrote or deleted, or no live segment backs it (a published
/// manifest row of its page and occurrence with the row's segment hash).
pub(super) fn swept(
    read: &dyn KvRead,
    d: &DerivationRecord,
    page: &PageRecord,
    occurrence: i64,
    rewritten: &HashSet<i64>,
) -> Result<bool> {
    if rewritten.contains(&(page.id as i64)) || page.deleted_at_us.is_some() {
        return Ok(true);
    }
    let mut prefix = kind_key(MANIFEST);
    prefix.extend_from_slice(&page.id.to_be_bytes());
    prefix.extend_from_slice(&signed(occurrence));
    let mut backed = false;
    each_json::<ManifestRow>(read, &prefix, &mut |_, m| {
        backed = m.gen_to.is_none()
            && m.staging_id.is_none()
            && m.sha256.eq_ignore_ascii_case(&d.segment_sha256);
        Ok(!backed)
    })?;
    Ok(!backed)
}

impl Store {
    /// `probePurgeDerivations`: one batch of at most `rows` stored derivation results of the source after the cursor, in key order:
    /// how many were walked, how many passed the claim prefilter, how many hold a claim and are swept, how many hold one and are
    /// kept, and the last key walked. The walk starts at the cursor and stops at the batch: later results are never read.
    pub fn probe_purge_derivations(&self, q: &DerivationProbeArgs) -> Result<Value> {
        const OP: &str = "probePurgeDerivations";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        for text in q.needles.iter().chain(&q.patterns) {
            no_nul(OP, &[("needles", text)])?;
        }
        let rows = usize::try_from(q.rows)
            .map_err(|_| StoreError::invalid(format!("{OP}: rows must not be negative")))?;
        let prefix = kind_key(DERIVATION);
        let from = match &q.cursor {
            None => prefix.clone(),
            Some(c) => {
                let occurrence: i64 = c.occurrence.trim().parse().map_err(|_| {
                    StoreError::invalid(format!(
                        "invalid input syntax for type bigint: \"{}\"",
                        c.occurrence
                    ))
                })?;
                let Some(page) = page_u64(c.page) else {
                    return Ok(
                        json!({ "scanned": 0, "normalized": 0, "swept": 0, "kept": 0,
                        "last_page": null, "last_pipeline": null, "last_occurrence": null }),
                    );
                };
                let mut key = derivation_key(page, &c.pipeline, occurrence);
                // The smallest key after the cursor's.
                key.push(0);
                key
            }
        };
        let rewritten: HashSet<i64> = q.page_ids.iter().copied().collect();
        let read = self.read()?;
        let (mut scanned, mut normalized, mut swept_hits, mut kept) = (0, 0, 0, 0);
        let mut last: Option<(u64, String, i64)> = None;
        if rows > 0 {
            for_each_prefix_paged_from(&*read, &prefix, &from, 8, &mut |key, value| {
                let (Some(page_id), Some(tail)) = (
                    key.get(2..10).and_then(crate::keys::be8),
                    key.len().checked_sub(8),
                ) else {
                    return Ok(true);
                };
                let Some(page) = read_page_by_id(&*read, page_id)? else {
                    return Ok(true);
                };
                if page.source_id != q.source_id || tail < 11 {
                    return Ok(true);
                }
                let d: DerivationRecord =
                    serde_json::from_slice(value).map_err(StoreError::from)?;
                let pipeline = String::from_utf8_lossy(&key[10..tail - 1]).into_owned();
                let occurrence =
                    (crate::keys::be8(&key[tail..]).unwrap_or(0) ^ (1u64 << 63)) as i64;
                scanned += 1;
                last = Some((page_id, pipeline, occurrence));
                let text = format!("{} {}", sql_text(&d.output), sql_text(&d.receipt));
                if has_words(&text, &q.patterns) {
                    normalized += 1;
                    if holds_claim(&d, &q.needles, &q.patterns) {
                        if swept(&*read, &d, &page, occurrence, &rewritten)? {
                            swept_hits += 1;
                        } else {
                            kept += 1;
                        }
                    }
                }
                Ok(scanned < rows)
            })?;
        }
        Ok(json!({
            "scanned": scanned, "normalized": normalized, "swept": swept_hits, "kept": kept,
            "last_page": last.as_ref().map(|l| l.0), "last_pipeline": last.as_ref().map(|l| l.1.clone()),
            "last_occurrence": last.as_ref().map(|l| l.2.to_string()),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_matches_a_pattern_of_words_in_order_with_escaped_wildcards() {
        assert!(like("alice likes tea at noon", "%alice%likes%tea%"));
        assert!(!like("tea likes alice", "%alice%likes%tea%"));
        assert!(like("abc", "a_c") && !like("abbc", "a_c"));
        assert!(like("50% off", "%50\\% off%") && !like("50 off", "%50\\% off%"));
        assert!(like("a_b", "a\\_b") && !like("axb", "a\\_b"));
        assert!(like("a\\b", "a\\\\b"));
        assert!(like("", "%") && like("x", "%%") && !like("", "_"));
        assert!(like("aXbXc", "%X%c") && !like("aXbXd", "%X%c"));
    }

    #[test]
    fn a_documents_strings_and_keys_are_read_at_any_depth() {
        let mut out = Vec::new();
        strings_of(
            &serde_json::json!({ "k": ["a", { "inner": "b" }], "n": 1 }),
            &mut out,
        );
        out.sort();
        assert_eq!(out, ["a", "b", "inner", "k", "n"]);
        let mut top = Vec::new();
        strings_of(&serde_json::json!("just text"), &mut top);
        assert_eq!(top, ["just text"]);
    }
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
