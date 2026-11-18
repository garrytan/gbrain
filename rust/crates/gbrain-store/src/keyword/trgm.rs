//! A port of the pg_trgm scoring functions: `similarity`, `word_similarity`,
//! `strict_word_similarity` and `show_trgm` (contrib/pg_trgm/trgm_op.c, PostgreSQL 18, the default
//! build: KEEPONLYALNUM, IGNORECASE, DIVUNION, LPADDING 2, RPADDING 1).
//! Derived from PostgreSQL 18.6; licence and notice: third-party/postgresql/NOTICE.md
//!
//! - A word is a run of alphanumeric characters (`t_isalnum`). Each word is lowercased and padded
//!   as `"  word "`; its trigrams are the 3-character windows of that padded text.
//! - A trigram whose UTF-8 form is 3 bytes is kept as those bytes. A longer one is the low 3 bytes
//!   (little-endian) of the legacy PostgreSQL CRC-32 of its bytes (`compact_trigram`).
//! - Scores are `float4`: `common / (len1 + len2 - common)`, divided in f32.
//!
//! The operators compare the f32 score, widened to f64, with a GUC that is a double:
//! `similarity(a, b) as f64 >= TRGM_SIMILARITY_THRESHOLD` is `a % b`,
//! `trgm_word_similarity(a, b) as f64 >= TRGM_WORD_SIMILARITY_THRESHOLD` is `a <% b`, and
//! `trgm_strict_word_similarity(a, b) as f64 >= TRGM_STRICT_WORD_SIMILARITY_THRESHOLD` is `a <<% b`.
//!
//! Character classes: the parity database (PGLite) uses the libc `C.UTF-8` ctype, where `iswalnum`
//! and `towlower` cover non-ASCII letters. This port uses the tables the tsearch parser ports from
//! that ctype (`parser::is_alnum_char`, `stem::pg_lower`), not Rust's Unicode classes, which differ on
//! code points such as `\u{b2}` (a separator there, a letter-or-digit to Rust). A database with the `C`
//! ctype would treat every non-ASCII character as a separator.
//!
//! Other families call these functions (searchTakes and others), so the items carry
//! `allow(dead_code)` until a caller in this crate uses them.
#![allow(dead_code)]

use super::parser::is_alnum_char;
use super::stem::pg_lower;
use std::collections::HashMap;

/// `pg_trgm.similarity_threshold` default (`%`).
pub(crate) const TRGM_SIMILARITY_THRESHOLD: f64 = 0.3;
/// `pg_trgm.word_similarity_threshold` default (`<%`).
pub(crate) const TRGM_WORD_SIMILARITY_THRESHOLD: f64 = 0.6;
/// `pg_trgm.strict_word_similarity_threshold` default (`<<%`).
pub(crate) const TRGM_STRICT_WORD_SIMILARITY_THRESHOLD: f64 = 0.5;

type Trgm = [u8; 3];

const BOUND_LEFT: u8 = 0x01;
const BOUND_RIGHT: u8 = 0x02;

/// The table PostgreSQL's `pg_crc32_table` holds (the reflected 0xEDB88320 table).
const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

/// `INIT_LEGACY_CRC32` / `COMP_LEGACY_CRC32` / `FIN_LEGACY_CRC32`: the non-reflected update over
/// the reflected table.
fn legacy_crc32(bytes: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in bytes {
        let index = ((crc >> 24) ^ u32::from(b)) & 0xFF;
        crc = CRC_TABLE[index as usize] ^ (crc << 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// `compact_trigram`.
fn compact(chars: &[char]) -> Trgm {
    let mut buf = [0u8; 12];
    let mut len = 0;
    for c in chars {
        len += c.encode_utf8(&mut buf[len..]).len();
    }
    if len == 3 {
        [buf[0], buf[1], buf[2]]
    } else {
        let crc = legacy_crc32(&buf[..len]).to_le_bytes();
        [crc[0], crc[1], crc[2]]
    }
}

/// `towlower` of the C.UTF-8 ctype, as the tsearch lowercaser does it (`stem::pg_lower`).
fn lower(c: char) -> char {
    let mut buf = [0u8; 4];
    pg_lower(c.encode_utf8(&mut buf))
        .chars()
        .next()
        .unwrap_or(c)
}

/// `generate_trgm_only`: every trigram of every word, in order, with the word bounds when asked.
fn trigrams_in_order(text: &str, mut bounds: Option<&mut Vec<u8>>) -> Vec<Trgm> {
    let mut out = Vec::new();
    for word in text
        .split(|c: char| !is_alnum_char(c))
        .filter(|w| !w.is_empty())
    {
        let mut padded = vec![' ', ' '];
        padded.extend(word.chars().map(lower));
        padded.push(' ');
        let first = out.len();
        out.extend(padded.windows(3).map(compact));
        if let Some(b) = bounds.as_deref_mut() {
            b.resize(out.len(), 0);
            b[first] |= BOUND_LEFT;
            b[out.len() - 1] |= BOUND_RIGHT;
        }
    }
    out
}

/// `CMPTRGM`: compares the three bytes as C `char`, which is signed on the platforms PostgreSQL
/// builds for here (x86-64, wasm32).
fn cmp_trgm(a: &Trgm, b: &Trgm) -> std::cmp::Ordering {
    let signed = |t: &Trgm| [t[0] as i8, t[1] as i8, t[2] as i8];
    signed(a).cmp(&signed(b))
}

/// `generate_trgm`: the sorted, unique trigrams.
fn trigram_set(text: &str) -> Vec<Trgm> {
    let mut set = trigrams_in_order(text, None);
    set.sort_by(cmp_trgm);
    set.dedup();
    set
}

/// `show_trgm(text)`: the sorted, unique trigrams, printed as text when every byte is an ASCII
/// alphanumeric or a space, else as `0x` and six hex digits.
pub(crate) fn trigrams(text: &str) -> Vec<String> {
    trigram_set(text)
        .iter()
        .map(|t| {
            if t.iter().all(|&b| b.is_ascii_alphanumeric() || b == b' ') {
                String::from_utf8_lossy(t).into_owned()
            } else {
                format!(
                    "0x{:06x}",
                    u32::from(t[0]) << 16 | u32::from(t[1]) << 8 | u32::from(t[2])
                )
            }
        })
        .collect()
}

/// `CALCSML` with DIVUNION.
fn calc_sml(count: usize, len1: usize, len2: usize) -> f32 {
    count as f32 / (len1 + len2 - count) as f32
}

/// `similarity(a, b)`.
pub(crate) fn trgm_similarity(a: &str, b: &str) -> f32 {
    let (x, y) = (trigram_set(a), trigram_set(b));
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut count) = (0, 0, 0);
    while i < x.len() && j < y.len() {
        match cmp_trgm(&x[i], &y[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                count += 1;
                i += 1;
                j += 1;
            }
        }
    }
    calc_sml(count, x.len(), y.len())
}

/// `word_similarity(a, b)`: the greatest similarity between the trigrams of `a` and those of a
/// continuous extent of `b`.
pub(crate) fn trgm_word_similarity(a: &str, b: &str) -> f32 {
    word_similarity(a, b, false)
}

/// `strict_word_similarity(a, b)`: as `trgm_word_similarity`, with the extent's ends on word
/// bounds of `b`.
pub(crate) fn trgm_strict_word_similarity(a: &str, b: &str) -> f32 {
    word_similarity(a, b, true)
}

/// `calc_word_similarity` and `iterate_word_similarity` (without WORD_SIMILARITY_CHECK_ONLY).
fn word_similarity(a: &str, b: &str, strict: bool) -> f32 {
    let trg1 = trigrams_in_order(a, None);
    let mut bounds = Vec::new();
    let trg2 = trigrams_in_order(b, strict.then_some(&mut bounds));

    // Number each distinct trigram; `found` marks the ones `a` has.
    let mut ids: HashMap<Trgm, usize> = HashMap::new();
    let mut found: Vec<bool> = Vec::new();
    for t in &trg1 {
        let id = *ids.entry(*t).or_insert_with(|| {
            found.push(false);
            found.len() - 1
        });
        found[id] = true;
    }
    let ulen1 = found.len();
    let trg2_indexes: Vec<usize> = trg2
        .iter()
        .map(|t| {
            *ids.entry(*t).or_insert_with(|| {
                found.push(false);
                found.len() - 1
            })
        })
        .collect();

    let mut lastpos: Vec<Option<usize>> = vec![None; found.len()];
    let (mut ulen2, mut count) = (0usize, 0usize);
    let mut lower: Option<usize> = if strict { Some(0) } else { None };
    let mut smlr_max = 0.0f32;
    for (i, &trg_index) in trg2_indexes.iter().enumerate() {
        if lower.is_some() || found[trg_index] {
            if lastpos[trg_index].is_none() {
                ulen2 += 1;
                if found[trg_index] {
                    count += 1;
                }
            }
            lastpos[trg_index] = Some(i);
        }
        let is_upper = if strict {
            bounds[i] & BOUND_RIGHT != 0
        } else {
            found[trg_index]
        };
        if !is_upper {
            continue;
        }
        let upper = i;
        let low = match lower {
            Some(l) => l,
            None => {
                ulen2 = 1;
                i
            }
        };
        let mut smlr_cur = calc_sml(count, ulen1, ulen2);
        let (mut tmp_count, mut tmp_ulen2) = (count, ulen2);
        let prev_lower = low;
        let mut best_lower = low;
        for tmp_lower in low..=upper {
            if !strict || bounds[tmp_lower] & BOUND_LEFT != 0 {
                let smlr_tmp = calc_sml(tmp_count, ulen1, tmp_ulen2);
                if smlr_tmp > smlr_cur {
                    smlr_cur = smlr_tmp;
                    ulen2 = tmp_ulen2;
                    best_lower = tmp_lower;
                    count = tmp_count;
                }
            }
            let tmp_index = trg2_indexes[tmp_lower];
            if lastpos[tmp_index] == Some(tmp_lower) {
                tmp_ulen2 -= 1;
                if found[tmp_index] {
                    tmp_count -= 1;
                }
            }
        }
        lower = Some(best_lower);
        smlr_max = smlr_max.max(smlr_cur);
        for (tmp_lower, &tmp_index) in trg2_indexes
            .iter()
            .enumerate()
            .take(best_lower)
            .skip(prev_lower)
        {
            if lastpos[tmp_index] == Some(tmp_lower) {
                lastpos[tmp_index] = None;
            }
        }
    }
    smlr_max
}

#[cfg(test)]
mod tests {
    use super::*;

    type Row = (
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        &'static [&'static str],
    );

    /// (a, b, similarity, word_similarity, strict_word_similarity, show_trgm(a)), each as PGLite
    /// 0.5.16 (PostgreSQL 18.6, ctype C.UTF-8) prints it.
    #[rustfmt::skip]
    const GOLDEN: &[Row] = &[
        ("word", "words", "0.5714286", "0.8", "0.5714286", &["  w", " wo", "ord", "rd ", "wor"]),
        ("word", "two words", "0.36363637", "0.8", "0.5714286", &["  w", " wo", "ord", "rd ", "wor"]),
        ("hello world", "world hello", "1", "1", "1", &["  h", "  w", " he", " wo", "ell", "hel", "ld ", "llo", "lo ", "orl", "rld", "wor"]),
        ("Café", "cafe", "0.42857143", "0.6", "0.42857143", &["0xef5960", "  c", " ca", "0x544980", "caf"]),
        ("café", "CAFÉ", "1", "1", "1", &["0xef5960", "  c", " ca", "0x544980", "caf"]),
        ("naïve résumé", "naive resume", "0.23809524", "0.2631579", "0.23809524", &["0x966b48", "0xb96f40", "0xc46393", "0xc84e9d", "0xd8acd7", "0x12c44a", "  n", "  r", " na", "0x59a8da", "0x689f9d", "sum", "ve "]),
        ("", "abc", "0", "0", "0", &[]),
        ("a", "a", "1", "1", "1", &["  a", " a "]),
        ("a", "b", "0", "0", "0", &["  a", " a "]),
        ("ab", "abc def", "0.22222222", "0.6666667", "0.4", &["  a", " ab", "ab "]),
        ("Project Alpha", "project-alpha notes", "0.7", "1", "1", &["  a", "  p", " al", " pr", "alp", "ct ", "ect", "ha ", "jec", "lph", "oje", "pha", "pro", "roj"]),
        ("alpha", "the alphabet soup", "0.2631579", "0.8333333", "0.5", &["  a", " al", "alp", "ha ", "lph", "pha"]),
        ("foo bar", "foo_bar", "1", "1", "1", &["  b", "  f", " ba", " fo", "ar ", "bar", "foo", "oo "]),
        ("x1y2", "X1Y2 z", "0.71428573", "1", "1", &["  x", " x1", "1y2", "x1y", "y2 "]),
        ("kitten", "sitting", "0.071428575", "0.14285715", "0.071428575", &["  k", " ki", "en ", "itt", "kit", "ten", "tte"]),
        ("strict", "restricted strictly", "0.3529412", "0.85714287", "0.6", &["  s", " st", "ct ", "ict", "ric", "str", "tri"]),
        ("bob", "bobby bob", "0.5714286", "1", "1", &["  b", " bo", "bob", "ob "]),
        ("!!!", "???", "0", "0", "0", &[]),
        ("meeting notes 2026", "Meeting Notes 2025", "0.8095238", "0.8947368", "0.8095238", &["  2", "  m", "  n", " 20", " me", " no", "026", "202", "26 ", "eet", "es ", "eti", "ing", "mee", "ng ", "not", "ote", "tes", "tin"]),
        ("日本語", "日本語テキスト", "0.33333334", "0.75", "0.33333334", &["0x8194c0", "0x836e53", "0x1dc363", "0x1e22e9"]),
        ("Ünïcödé", "ünïcödé", "1", "1", "1", &["0x8c1b15", "0x9ab6cb", "0xabe363", "0x006375", "0x0d7f89", "0x4fd16d", "0x57ba36", "0x57bc55"]),
        ("acme example", "acme-example inc", "0.7647059", "1", "1", &["  a", "  e", " ac", " ex", "acm", "amp", "cme", "exa", "le ", "me ", "mpl", "ple", "xam"]),
        ("acme", "acmeexample", "0.30769232", "0.8", "0.30769232", &["  a", " ac", "acm", "cme", "me "]),
        ("pg", "postgres pg trgm", "0.1875", "1", "1", &["  p", " pg", "pg "]),
        // Characters the C.UTF-8 `iswalnum` treats as separators (superscript and fraction digits) or as letters.
        ("x", "x\u{b2}", "1", "1", "1", &["  x", " x "]),
        ("x", "x\u{bd}y", "0.5", "1", "1", &["  x", " x "]),
        ("ab", "ab\u{663}", "0.4", "0.6666667", "0.4", &["  a", " ab", "ab "]),
        ("x", "x\u{aa}", "0.25", "0.5", "0.25", &["  x", " x "]),
        ("abcabc", "abc", "0.6666667", "0.6666667", "0.6666667", &["  a", " ab", "abc", "bc ", "bca", "cab"]),
        ("trigram", "tri gram", "0.54545456", "0.54545456", "0.54545456", &["  t", " tr", "am ", "gra", "igr", "ram", "rig", "tri"]),
        ("tit", "title of it", "0.33333334", "0.75", "0.42857143", &["  t", " ti", "it ", "tit"]),
    ];

    #[test]
    fn scores_and_trigrams_match_pglite() {
        for (a, b, s, w, sw, show) in GOLDEN {
            assert_eq!(
                trgm_similarity(a, b).to_string(),
                *s,
                "similarity({a:?}, {b:?})"
            );
            assert_eq!(
                trgm_word_similarity(a, b).to_string(),
                *w,
                "word_similarity({a:?}, {b:?})"
            );
            assert_eq!(
                trgm_strict_word_similarity(a, b).to_string(),
                *sw,
                "strict_word_similarity({a:?}, {b:?})"
            );
            assert_eq!(trigrams(a), *show, "show_trgm({a:?})");
        }
    }

    #[test]
    fn operators_compare_the_widened_score_with_the_threshold() {
        // PGLite: 'acme' % 'acmeexample' (0.30769232) and 'ab' <% 'abc def' (0.6666667) hold;
        // 'trigram' <% 'tri gram' (0.54545456) does not.
        assert!(f64::from(trgm_similarity("acme", "acmeexample")) >= TRGM_SIMILARITY_THRESHOLD);
        assert!(f64::from(trgm_word_similarity("ab", "abc def")) >= TRGM_WORD_SIMILARITY_THRESHOLD);
        assert!(
            f64::from(trgm_word_similarity("trigram", "tri gram")) < TRGM_WORD_SIMILARITY_THRESHOLD
        );
        assert!(
            f64::from(trgm_strict_word_similarity("alpha", "the alphabet soup"))
                >= TRGM_STRICT_WORD_SIMILARITY_THRESHOLD
        );
    }
}
