//! The fact fingerprints against PGLite, byte for byte.
//!
//! Withdrawals and purge tombstones key on `gbrain_fact_fingerprint` and
//! `gbrain_fact_fingerprint_v1`, so a Rust value that differs from the SQL by one byte lets a forgotten
//! claim come back. The SQL (src/core/facts/withdrawal-schema.ts) is built from per-character rules
//! (`lower()`, the `[[:space:]]` class, a punctuation list) composed by a few regular expressions. So
//! this module checks:
//!
//! 1. every per-character rule over all 1,112,063 code points against PGLite's own tables;
//! 2. both fingerprint versions, and the normalized text, for the whole fixture corpus (hand rows
//!    for every whitespace class, Turkish I, sharp s, final sigma, ligatures, combining marks, NFC
//!    and NFD pairs, RTL, CJK, emoji, long text, plus seeded random rows);
//! 3. properties on random text: both Rust copies agree, the result equals a step-by-step model of
//!    the SQL built from PGLite's tables, and case, whitespace and edge-space changes that the SQL
//!    folds leave the fingerprint unchanged.
//!
//! The fixture comes from PGLite (rust/scripts/fact-fingerprint-fixture.ts) and
//! test/fact-fingerprint-corpus.test.ts recomputes it on PGLite in every test run.

use super::fingerprint::{
    fact_fingerprint, fact_fingerprint_v1, fact_normalize, pg_lower_char, pg_space,
};
use crate::fingerprint_fixture::{fixture, lower_mismatches, space_mismatches};
use proptest::prelude::*;
use sha2::{Digest, Sha256};

/// `FINGERPRINT_PUNCTUATION` (src/core/facts/withdrawal-schema.ts), spelled again here on purpose:
/// a change to the Rust copy must not also change the model it is checked against.
const PUNCTUATION: &str = "!\"$%&'()*,-/:;<=>?@[\\]^_`{|}~\u{2018}\u{2019}\u{201a}\u{201c}\u{201d}\u{201e}\u{00ab}\u{00bb}\u{2039}\u{203a}\u{2013}\u{2014}\u{2015}\u{2026}\u{00b7}\u{2022}\u{00a1}\u{00bf}";

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn every_code_point_lowers_like_pglite() {
    assert_eq!(lower_mismatches(pg_lower_char), Vec::<String>::new());
    assert_eq!(
        lower_mismatches(crate::facts::pg_lower_char),
        Vec::<String>::new()
    );
}

#[test]
fn every_code_point_is_or_is_not_space_like_pglite() {
    assert_eq!(space_mismatches(pg_space), Vec::<String>::new());
}

#[test]
fn every_corpus_claim_fingerprints_like_pglite() {
    let f = fixture();
    let mut wrong = Vec::new();
    for row in &f.rows {
        let text = row.text();
        let checks = [
            ("fingerprint", fact_fingerprint(&text), &row.fingerprint),
            (
                "fingerprint (facts copy)",
                crate::facts::fact_fingerprint(&text),
                &row.fingerprint,
            ),
            (
                "fingerprint_v1",
                fact_fingerprint_v1(&text),
                &row.fingerprint_v1,
            ),
        ];
        for (what, got, want) in checks {
            if &got != want {
                wrong.push(format!("{}: {what} {got} but PGLite {want}", row.name));
            }
        }
        if let Some(want) = &row.normalize {
            for (what, got) in [
                ("normalize", fact_normalize(&text)),
                (
                    "normalize (facts copy)",
                    crate::facts::fact_normalize(&text),
                ),
            ] {
                if &got != want {
                    wrong.push(format!("{}: {what} {got:?} but PGLite {want:?}", row.name));
                }
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} mismatches:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

/// The SQL of `gbrain_fact_normalize`, one statement step at a time, over PGLite's tables:
/// `btrim(regexp_replace(regexp_replace(regexp_replace(translate(lower(claim), P, ' '),
/// '[[:space:]]+', ' ', 'g'), '\.(?=[. ]|$)', ' ', 'g'), ' +', ' ', 'g'), ' ')`.
fn model_normalize(text: &str) -> String {
    let f = fixture();
    // lower(), then translate() of the punctuation list to spaces.
    let step1: Vec<char> = text
        .chars()
        .map(|c| f.lower(c))
        .map(|c| if PUNCTUATION.contains(c) { ' ' } else { c })
        .collect();
    let step2 = collapse(&step1, |c| f.space(c));
    // `\.(?=[. ]|$)` to a space: the lookahead reads the text before this step's replacements.
    let step3: Vec<char> = (0..step2.len())
        .map(|i| {
            let next = step2.get(i + 1);
            if step2[i] == '.' && (next.is_none() || next == Some(&'.') || next == Some(&' ')) {
                ' '
            } else {
                step2[i]
            }
        })
        .collect();
    let step4 = collapse(&step3, |c| c == ' ');
    step4
        .into_iter()
        .collect::<String>()
        .trim_matches(' ')
        .to_string()
}

/// `regexp_replace(text, '<class>+', ' ', 'g')`: each maximal run of class characters becomes one
/// space.
fn collapse(chars: &[char], class: impl Fn(char) -> bool) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if class(chars[i]) {
            while i < chars.len() && class(chars[i]) {
                i += 1;
            }
            out.push(' ');
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// The SQL of `gbrain_fact_fingerprint_v1`'s input:
/// `regexp_replace(lower(btrim(claim)), '[[:space:]]+', ' ', 'g')`.
fn model_v1_input(text: &str) -> String {
    let f = fixture();
    let lowered: Vec<char> = text.trim_matches(' ').chars().map(|c| f.lower(c)).collect();
    collapse(&lowered, |c| f.space(c)).into_iter().collect()
}

#[test]
fn the_model_reproduces_the_pglite_corpus() {
    // The model is only worth comparing against if it is right: it must give PGLite's answer for
    // every corpus row before it judges random text.
    let f = fixture();
    for row in &f.rows {
        let text = row.text();
        assert_eq!(
            sha256_hex(&model_normalize(&text)),
            row.fingerprint,
            "{}",
            row.name
        );
        assert_eq!(
            sha256_hex(&model_v1_input(&text)),
            row.fingerprint_v1,
            "{}",
            row.name
        );
    }
}

/// Characters weighted toward what the SQL treats specially, plus any scalar value but U+0000.
fn claim_char() -> impl Strategy<Value = char> {
    let special: Vec<char> = concat!(
        " \t\n\r\u{b}\u{c}\u{85}\u{a0}\u{1680}\u{2000}\u{2003}\u{2007}\u{200a}\u{200b}\u{200d}",
        "\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}...!?,;:'\"-_#+",
        "\u{2014}\u{2026}\u{201c}\u{201d}\u{2018}\u{2019}\u{00ab}\u{00bb}\u{00bf}\u{00a1}",
        "AZaz09\u{130}\u{131}Ii\u{df}\u{1e9e}\u{3a3}\u{3c3}\u{3c2}\u{1fbc}\u{1c5}\u{fb01}\u{149}",
        "\u{212a}\u{212b}\u{2126}\u{216b}\u{24b6}\u{ff21}\u{13a0}\u{1c90}\u{2c2f}\u{a7c0}\u{10570}",
        "\u{10400}\u{1e900}\u{301}\u{308}\u{30a}\u{4e2d}\u{5e9}\u{645}\u{200e}\u{202e}\u{1f468}\u{fe0f}"
    )
    .chars()
    .collect();
    prop_oneof![
        6 => proptest::sample::select(special),
        3 => proptest::char::range('a', 'z'),
        2 => proptest::char::range('A', 'Z'),
        2 => proptest::char::any().prop_filter("a Postgres text holds no U+0000", |c| *c != '\0'),
    ]
}

fn claim() -> impl Strategy<Value = String> {
    proptest::collection::vec(claim_char(), 0..64).prop_map(|chars| chars.into_iter().collect())
}

/// A run of characters every engine folds to one space before anything else happens.
fn space_run() -> impl Strategy<Value = String> {
    proptest::collection::vec(
        proptest::sample::select(vec![
            ' ', '\t', '\n', '\r', '\u{85}', '\u{2003}', '\u{3000}',
        ]),
        1..5,
    )
    .prop_map(|chars| chars.into_iter().collect())
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 512,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn the_two_rust_copies_agree(text in claim()) {
        prop_assert_eq!(crate::facts::fact_normalize(&text), fact_normalize(&text));
        prop_assert_eq!(crate::facts::fact_fingerprint(&text), fact_fingerprint(&text));
    }

    #[test]
    fn both_versions_equal_the_sql_model_over_pglite_tables(text in claim()) {
        prop_assert_eq!(fact_normalize(&text), model_normalize(&text));
        prop_assert_eq!(fact_fingerprint(&text), sha256_hex(&model_normalize(&text)));
        prop_assert_eq!(fact_fingerprint_v1(&text), sha256_hex(&model_v1_input(&text)));
    }

    #[test]
    fn folded_variants_keep_their_fingerprint(
        words in proptest::collection::vec("[a-z]{1,8}", 1..6),
        gaps in proptest::collection::vec(space_run(), 6),
        edge in space_run(),
        trailing_dot in any::<bool>(),
    ) {
        // The claim a user first saved, and the same claim with other capitals, other whitespace
        // runs between words and around it, and an optional sentence dot: a withdrawal of one must
        // reach the other, so the fingerprints must be equal.
        let plain = words.join(" ");
        let mut variant = edge.clone();
        for (i, w) in words.iter().enumerate() {
            if i > 0 {
                variant.push_str(&gaps[i]);
            }
            variant.push_str(&w.to_ascii_uppercase());
        }
        if trailing_dot {
            variant.push('.');
        }
        variant.push_str(&edge);
        prop_assert_eq!(fact_fingerprint(&variant), fact_fingerprint(&plain));
        // v1 folds case and inner whitespace runs, trims only ' ' at the edges and keeps a dot.
        let mut v1_variant = String::from("  ");
        for (i, w) in words.iter().enumerate() {
            if i > 0 {
                v1_variant.push_str(&gaps[i]);
            }
            v1_variant.push_str(&w.to_ascii_uppercase());
        }
        v1_variant.push_str("   ");
        prop_assert_eq!(fact_fingerprint_v1(&v1_variant), fact_fingerprint_v1(&plain));
    }
}
