//! The PGLite answers the Rust ports of Postgres text functions are tested against, read from
//! tests/fixtures/fact_fingerprints.json (written by rust/scripts/fact-fingerprint-fixture.ts, kept
//! fresh by test/fact-fingerprint-corpus.test.ts):
//!
//! - `lower()` of every code point, and which code points the `[[:space:]]` class holds, so every
//!   port of a per-character rule can be checked over all 1,112,063 scalar values;
//! - the claim corpus with `gbrain_fact_normalize`, `gbrain_fact_fingerprint` and
//!   `gbrain_fact_fingerprint_v1` for each claim.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const FIXTURE: &str = include_str!("../tests/fixtures/fact_fingerprints.json");

#[derive(Deserialize)]
pub(crate) struct Row {
    pub(crate) name: String,
    text: Option<String>,
    rep: Option<(String, usize, String)>,
    pub(crate) normalize: Option<String>,
    pub(crate) fingerprint: String,
    pub(crate) fingerprint_v1: String,
}

impl Row {
    /// The claim: `text`, or `unit` repeated `count` times followed by `suffix`.
    pub(crate) fn text(&self) -> String {
        match (&self.text, &self.rep) {
            (_, Some((unit, count, suffix))) => unit.repeat(*count) + suffix,
            (Some(text), None) => text.clone(),
            (None, None) => String::new(),
        }
    }
}

#[derive(Deserialize)]
struct Raw {
    seeded_count: usize,
    lower: Vec<(u32, u32)>,
    space: Vec<u32>,
    rows: Vec<Row>,
}

pub(crate) struct Fixture {
    lower: HashMap<u32, u32>,
    space: HashSet<u32>,
    pub(crate) rows: Vec<Row>,
}

impl Fixture {
    /// PGLite's `lower(chr(c))`.
    pub(crate) fn lower(&self, c: char) -> char {
        self.lower
            .get(&(c as u32))
            .and_then(|&l| char::from_u32(l))
            .unwrap_or(c)
    }

    /// Whether PGLite's `[[:space:]]` matches `c`.
    pub(crate) fn space(&self, c: char) -> bool {
        self.space.contains(&(c as u32))
    }
}

/// The parsed fixture, checked for the shape the tests rely on.
pub(crate) fn fixture() -> &'static Fixture {
    static PARSED: OnceLock<Fixture> = OnceLock::new();
    PARSED.get_or_init(|| {
        let raw: Raw = serde_json::from_str(FIXTURE).expect("fact_fingerprints.json parses");
        let seeded = raw
            .rows
            .iter()
            .filter(|r| r.name.starts_with("seeded "))
            .count();
        assert_eq!(
            seeded, raw.seeded_count,
            "every seeded row is in the fixture"
        );
        assert!(
            raw.rows.len() > seeded + 300,
            "the hand corpus is in the fixture"
        );
        assert!(
            raw.lower.len() > 1000,
            "lower() changes over a thousand code points"
        );
        Fixture {
            lower: raw.lower.into_iter().collect(),
            space: raw.space.into_iter().collect(),
            rows: raw.rows,
        }
    })
}

/// Every scalar value a Postgres `text` can hold: all of them but U+0000.
pub(crate) fn text_chars() -> impl Iterator<Item = char> {
    (1..=0x10FFFF_u32).filter_map(char::from_u32)
}

/// Checks a port of `lower(chr(c))` over every code point; returns the first mismatches.
pub(crate) fn lower_mismatches(port: impl Fn(char) -> char) -> Vec<String> {
    let f = fixture();
    text_chars()
        .filter(|&c| port(c) != f.lower(c))
        .take(20)
        .map(|c| {
            format!(
                "U+{:04X}: port gives U+{:04X}, PGLite gives U+{:04X}",
                c as u32,
                port(c) as u32,
                f.lower(c) as u32
            )
        })
        .collect()
}

/// Checks a port of `c ~ '[[:space:]]'` over every code point; returns the first mismatches.
pub(crate) fn space_mismatches(port: impl Fn(char) -> bool) -> Vec<String> {
    let f = fixture();
    text_chars()
        .filter(|&c| port(c) != f.space(c))
        .take(20)
        .map(|c| {
            format!(
                "U+{:04X}: port says {}, PGLite says {}",
                c as u32,
                port(c),
                f.space(c)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_text_ports_match_pglite_on_every_code_point() {
        use crate::cli_reads::pg_text::{is_pg_space, lower_char};
        assert_eq!(lower_mismatches(lower_char), Vec::<String>::new());
        assert_eq!(space_mismatches(is_pg_space), Vec::<String>::new());
    }
}
