use super::*;

/// `ts_lexize('german_stem', word)` from the parity reference (PGLite, Snowball 3.0.0), one word per
/// line: the word, a tab, then the lexeme, an empty field for a stopword (`{}`).
const PGLITE: &str = include_str!("pglite_german_stem.tsv");

#[test]
fn every_word_stems_as_pglite_stems_it() {
    let mut checked = 0;
    let mut wrong = Vec::new();
    for line in PGLITE.lines().filter(|l| !l.is_empty()) {
        let (word, want) = line.split_once('\t').unwrap();
        let want = (!want.is_empty()).then(|| want.to_string());
        let got = german_stem(word);
        if got != want {
            wrong.push(format!("{word}: got {got:?}, PGLite {want:?}"));
        }
        checked += 1;
    }
    assert!(checked > 300, "the fixture holds {checked} words");
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn stopwords_empty_words_and_long_words_follow_dsnowball_lexize() {
    assert_eq!(german_stem(""), None);
    assert_eq!(german_stem("Aber"), None);
    let long = "Häuser".repeat(200);
    assert_eq!(german_stem(&long), Some(pg_lower(&long)));
    // Snowball 3.0 strips the feminine endings (Postgres 16's older Snowball keeps them).
    assert_eq!(german_stem("Lehrerinnen").as_deref(), Some("lehr"));
}
