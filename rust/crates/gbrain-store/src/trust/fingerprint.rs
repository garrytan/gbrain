//! The claim fingerprints of the fact withdrawal ledger: Postgres `gbrain_fact_fingerprint` and
//! `gbrain_fact_fingerprint_v1` (src/core/facts/withdrawal-schema.ts) as Rust functions.
//!
//! A copy of the facts family's fingerprint (facts.rs on the facts-sites line), which this base
//! does not have yet. The two copies merge into one when both lines meet.

use sha2::{Digest, Sha256};

/// Code points Postgres `lower()` leaves alone that Rust's `char::to_lowercase` maps (the two
/// Unicode tables differ). Probed on PGLite.
const LOWER_KEEP: [(u32, u32); 41] = [
    (0x1C89, 0x1C89),
    (0x24B6, 0x24CF),
    (0x2C2F, 0x2C2F),
    (0xA7C0, 0xA7C0),
    (0xA7C7, 0xA7C7),
    (0xA7C9, 0xA7C9),
    (0xA7CB, 0xA7CC),
    (0xA7CE, 0xA7CE),
    (0xA7D0, 0xA7D0),
    (0xA7D2, 0xA7D2),
    (0xA7D4, 0xA7D4),
    (0xA7D6, 0xA7D6),
    (0xA7D8, 0xA7D8),
    (0xA7DA, 0xA7DA),
    (0xA7DC, 0xA7DD),
    (0xA7E2, 0xA7E2),
    (0xA7F5, 0xA7F5),
    (0xAB6C, 0xAB6D),
    (0x10570, 0x1057A),
    (0x1057C, 0x1058A),
    (0x1058C, 0x10592),
    (0x10594, 0x10595),
    (0x10D50, 0x10D65),
    (0x16EA0, 0x16EB8),
    (0x1DF40, 0x1DF40),
    (0x1DF48, 0x1DF48),
    (0x1DF4A, 0x1DF4A),
    (0x1DF4D, 0x1DF4D),
    (0x1DF51, 0x1DF51),
    (0x1DF68, 0x1DF68),
    (0x1DF6A, 0x1DF6A),
    (0x1DF6C, 0x1DF6C),
    (0x1DF6E, 0x1DF6E),
    (0x1DF72, 0x1DF72),
    (0x1DF74, 0x1DF74),
    (0x1DF76, 0x1DF76),
    (0x1DF78, 0x1DF78),
    (0x1DF7A, 0x1DF7A),
    (0x1DF7C, 0x1DF7C),
    (0x1DF7E, 0x1DF7E),
    (0xFEFF, 0xFEFF),
];

/// Postgres `lower()` of one code point: one code point out, the first of the full mapping
/// ('İ' gives 'i').
pub(crate) fn pg_lower_char(c: char) -> char {
    let cp = c as u32;
    if LOWER_KEEP.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp)) {
        return c;
    }
    c.to_lowercase().next().unwrap_or(c)
}

/// `[[:space:]]` in a Postgres regular expression.
pub(crate) fn pg_space(c: char) -> bool {
    matches!(c as u32, 9..=13 | 32 | 133 | 8192..=8198 | 8200..=8202 | 8232 | 8233 | 8287 | 12288)
}

/// Characters `gbrain_fact_normalize` turns into a space (`FINGERPRINT_PUNCTUATION`).
const FINGERPRINT_PUNCTUATION: &str = "!\"$%&'()*,-/:;<=>?@[\\]^_`{|}~\u{2018}\u{2019}\u{201a}\u{201c}\u{201d}\u{201e}\u{00ab}\u{00bb}\u{2039}\u{203a}\u{2013}\u{2014}\u{2015}\u{2026}\u{00b7}\u{2022}\u{00a1}\u{00bf}";

/// `gbrain_fact_normalize(text)`: lower-case, punctuation and whitespace runs to one space, a
/// sentence-ending dot dropped, trimmed.
pub(crate) fn fact_normalize(text: &str) -> String {
    let mut spaced = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars().map(pg_lower_char) {
        let c = if FINGERPRINT_PUNCTUATION.contains(c) {
            ' '
        } else {
            c
        };
        if pg_space(c) {
            if !in_space {
                spaced.push(' ');
            }
            in_space = true;
        } else {
            spaced.push(c);
            in_space = false;
        }
    }
    // `\.(?=[. ]|$)` to a space, then `' +'` to one space, then btrim.
    let chars: Vec<char> = spaced.chars().collect();
    let mut out = String::with_capacity(spaced.len());
    let mut last_space = false;
    for (i, &c) in chars.iter().enumerate() {
        let c = if c == '.' && chars.get(i + 1).is_none_or(|n| *n == '.' || *n == ' ') {
            ' '
        } else {
            c
        };
        if c == ' ' {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim_matches(' ').to_string()
}

/// `gbrain_fact_fingerprint(text)`: the sha256 hex of `gbrain_fact_normalize(text)`.
pub(crate) fn fact_fingerprint(text: &str) -> String {
    hex(&fact_normalize(text))
}

/// `gbrain_fact_fingerprint_v1(text)`: the sha256 hex of
/// `regexp_replace(lower(btrim(claim)), '[[:space:]]+', ' ', 'g')`. `btrim` trims only `' '`, and
/// nothing is trimmed after the collapse.
pub(crate) fn fact_fingerprint_v1(text: &str) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.trim_matches(' ').chars().map(pg_lower_char) {
        if pg_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    hex(&collapsed)
}

fn hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
