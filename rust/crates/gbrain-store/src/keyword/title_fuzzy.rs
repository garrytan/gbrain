//! `findByTitleFuzzy(name, dirPrefix?, minSimilarity?, sourceId?)`: the page whose title is most
//! like `name` by pg_trgm `similarity`, as `engine-sql/pages.ts` selects it:
//!
//! ```sql
//! SELECT slug, similarity(title, $name) AS sim FROM pages
//! WHERE [title % $name AND]           -- only when minSimilarity >= 0.3
//!       similarity(title, $name) >= $minSimilarity
//!   AND slug LIKE ($dirPrefix || '/%' or '%')
//!   [AND source_id = $sourceId AND deleted_at IS NULL]  -- only when sourceId is truthy
//! ORDER BY sim DESC, slug ASC LIMIT 1
//! ```
//!
//! `similarity` is a `real`, and PGLite types the `$minSimilarity` parameter from it, so the test
//! is an f32 comparison; `%` compares the f32 score with the f64 threshold 0.3. The unscoped arm
//! reads soft-deleted pages too (follow-up `fuzzy-title-unscoped-deleted`).
//!
//! When the keyword index serves, only the pages whose titles share enough of the name's trigrams
//! (`R 0x03`, [`min_shared`]) are read and scored; else every page is.

use super::index::{serves, title_trigram_pages};
use super::trgm::{TRGM_SIMILARITY_THRESHOLD, trgm_similarity, trigram_bytes};
use crate::Store;
use crate::cli_reads::pg_text::pg_lower;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use serde_json::{Value, json};

/// `findByTitleFuzzy`'s default `minSimilarity`.
pub(crate) const DEFAULT_MIN_SIMILARITY: f64 = 0.55;

/// One element of a LIKE pattern once its escapes are read.
#[derive(Clone, Copy)]
enum Like {
    /// `%`: any run of characters, also none.
    Any,
    /// `_`: exactly one character.
    One,
    /// A character that stands for itself (an escaped `%`, `_` or `\\` too).
    Char(char),
}

/// SQL `LIKE` with the default escape character `\`: `%` matches any run of characters, `_` one
/// character, and `\x` the character `x`. A trailing lone `\` matches nothing, as in PG 18 when
/// the text is used up first (the patterns built here never end in one).
///
/// Iterative, with one backtrack point (the last `%`): once a later part of the pattern has matched
/// after a `%`, no earlier `%` can do better, so the work is at most the text length times the
/// pattern length and a pattern of many `%` cannot make it explode.
pub(crate) fn sql_like(text: &str, pattern: &str) -> bool {
    let mut tokens: Vec<Like> = Vec::with_capacity(pattern.len());
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        tokens.push(match c {
            '%' => Like::Any,
            '_' => Like::One,
            '\\' => match chars.next() {
                Some(escaped) => Like::Char(escaped),
                None => return false,
            },
            c => Like::Char(c),
        });
    }
    let t: Vec<char> = text.chars().collect();
    let (mut ti, mut pi) = (0, 0);
    // Where the last `%` left off: the token after it and the text position it has consumed up to.
    let mut resume: Option<(usize, usize)> = None;
    while ti < t.len() {
        match tokens.get(pi) {
            Some(Like::Any) => {
                pi += 1;
                resume = Some((pi, ti));
                continue;
            }
            Some(Like::One) => {
                ti += 1;
                pi += 1;
                continue;
            }
            Some(Like::Char(c)) if *c == t[ti] => {
                ti += 1;
                pi += 1;
                continue;
            }
            _ => {}
        }
        match resume {
            Some((after, consumed)) => {
                // Let the last `%` take one more character and try the rest of the pattern again.
                resume = Some((after, consumed + 1));
                pi = after;
                ti = consumed + 1;
            }
            None => return false,
        }
    }
    tokens[pi..].iter().all(|token| matches!(token, Like::Any))
}

/// SQL `ILIKE`: [`sql_like`] after both sides are lowered one character at a time with PGLite's
/// case table (`pg_lower`), as Postgres lowers both sides for a multibyte database. `%`, `_` and
/// `\` in the pattern stay wildcards and the escape.
pub(crate) fn sql_ilike(text: &str, pattern: &str) -> bool {
    sql_like(&pg_lower(text), &pg_lower(pattern))
}

/// A JS number bound to a `real` parameter: PG reads its text with `strtof`, and a finite value
/// that rounds to infinity or to zero from a non-zero value is out of range.
fn real_param(value: f64) -> Result<f32> {
    // Rust prints the shortest text that reads back as `value`; parsing that text as f32 rounds
    // once, as strtof does on the text PGLite sends.
    let real: f32 = format!("{value}").parse().map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type real: \"{value}\""))
    })?;
    if value.is_finite() && (real.is_infinite() || (real == 0.0 && value != 0.0)) {
        return Err(StoreError::invalid(format!(
            "\"{value}\" is out of range for type real"
        )));
    }
    Ok(real)
}

/// The largest name trigram set [`min_shared`] is proved for; a larger one admits every title that
/// shares a trigram.
const BOUND_TRIGRAMS: usize = 2_048;

/// The fewest trigrams a title must share with a name of `n1` trigrams to have f32 similarity
/// `>= min`, or `None` when a title sharing none can (`min` zero, negative or not finite: the read
/// scans).
///
/// `similarity` is `c / (n1 + n2 - c)` divided once in f32, with both sides exact, and `n2 >= c`,
/// so the real quotient is at most `c / n1`. A correctly rounded quotient exceeds the real one by
/// at most half a step, so a score `>= min` means the real quotient is above `min` lowered by one
/// f32 step; `t_low` lowers it by two. Then `c >= n1 * t_low`, a product f64 holds exactly, and
/// `c` is an integer. The exhaustive test checks this against `calc_sml`.
pub(super) fn min_shared(n1: usize, min: f32) -> Option<usize> {
    if !min.is_finite() || min <= 0.0 {
        return None;
    }
    if n1 > BOUND_TRIGRAMS {
        return Some(1);
    }
    let t_low = f32::from_bits(min.to_bits().saturating_sub(2));
    let need = (n1 as f64 * f64::from(t_low)).ceil();
    Some((need as usize).max(1))
}

/// The pages the fuzzy read scores: those the trigram postings admit, in page-id order, or every
/// page. Order does not change the answer: it is the best `(similarity, slug)`, and two pages that
/// tie on both answer the same `{ slug, similarity }`.
fn fuzzy_pages(read: &dyn KvRead, name: &str, min: f32) -> Result<Vec<PageRecord>> {
    let trigrams = trigram_bytes(name);
    let need = min_shared(trigrams.len(), min);
    let (true, Some(need)) = (serves(read)?, need) else {
        return all_pages(read);
    };
    #[cfg(test)]
    super::index::tests::served_by_index();
    let mut pages = Vec::new();
    for id in title_trigram_pages(read, &trigrams, need)? {
        if let Some(page) = read_page_by_id(read, id)? {
            pages.push(page);
        }
    }
    Ok(pages)
}

/// A `real` as JavaScript reads it from PGLite: the shortest text that reads back as the f32.
pub(crate) fn real_to_js(value: f32) -> f64 {
    format!("{value}").parse().unwrap_or(f64::from(value))
}

impl Store {
    /// `findByTitleFuzzy`: `{ slug, similarity }` or `null`. `dir_prefix` and `source_id` scope the
    /// read only when they are non-empty, as the SQL engines' truthiness tests do. The caller
    /// passes `None` for `min_similarity` only when it is `undefined` (the default 0.55 applies).
    pub fn find_by_title_fuzzy(
        &self,
        name: &str,
        dir_prefix: Option<&str>,
        min_similarity: Option<f64>,
        source_id: Option<&str>,
    ) -> Result<Value> {
        let min = min_similarity.unwrap_or(DEFAULT_MIN_SIMILARITY);
        let min_real = real_param(min)?;
        let prefilter = min >= TRGM_SIMILARITY_THRESHOLD;
        let pattern = match dir_prefix.filter(|d| !d.is_empty()) {
            Some(d) => format!("{d}/%"),
            None => "%".to_string(),
        };
        let source = source_id.filter(|s| !s.is_empty());
        let read = self.read()?;
        let mut best: Option<(f32, String)> = None;
        for page in fuzzy_pages(&*read, name, min_real)? {
            if let Some(s) = source
                && (page.source_id != s || page.deleted_at_us.is_some())
            {
                continue;
            }
            let sim = trgm_similarity(&page.title, name);
            if prefilter && f64::from(sim) < TRGM_SIMILARITY_THRESHOLD {
                continue;
            }
            // NaN never compares true, as a float4 NaN parameter matches no finite score.
            let below = sim
                .partial_cmp(&min_real)
                .is_none_or(std::cmp::Ordering::is_lt);
            if below || !sql_like(&page.slug, &pattern) {
                continue;
            }
            let better = match &best {
                None => true,
                Some((bs, bslug)) => {
                    sim > *bs || (sim == *bs && page.slug.as_bytes() < bslug.as_bytes())
                }
            };
            if better {
                best = Some((sim, page.slug));
            }
        }
        Ok(best.map_or(
            Value::Null,
            |(sim, slug)| json!({ "slug": slug, "similarity": real_to_js(sim) }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs `sql_like` on its own thread and fails the test, instead of hanging it, when it does not answer in time.
    fn like_within(text: &str, pattern: &str, limit: std::time::Duration) -> Option<bool> {
        let (tx, rx) = std::sync::mpsc::channel();
        let (text, pattern) = (text.to_string(), pattern.to_string());
        std::thread::spawn(move || {
            let _ = tx.send(sql_like(&text, &pattern));
        });
        rx.recv_timeout(limit).ok()
    }

    #[test]
    fn like_with_many_percent_groups_answers_in_bounded_time() {
        let limit = std::time::Duration::from_secs(2);
        let slug = format!("{}/x", "a".repeat(64));
        let no = format!("{}b/%", "%a".repeat(24));
        let yes = format!("{}/%", "%a".repeat(24));
        assert_eq!(like_within(&slug, &no, limit), Some(false));
        assert_eq!(like_within(&slug, &yes, limit), Some(true));
        // The codex case: a 36-a slug against 18 `%a` groups and a literal the slug lacks.
        let slug = format!("{}/p", "a".repeat(36));
        let pattern = format!("{}b/%", "%a".repeat(18));
        assert_eq!(like_within(&slug, &pattern, limit), Some(false));
        // A long text and a long pattern of mixed wildcards stay polynomial.
        let text = "ab".repeat(5_000);
        let pattern = format!("{}c", "%_a%b_".repeat(200));
        assert_eq!(like_within(&text, &pattern, limit), Some(false));
        let pattern = format!("{}%", "%a_".repeat(200));
        assert_eq!(like_within(&text, &pattern, limit), Some(true));
    }

    #[test]
    fn like_edge_cases() {
        // Empty text and pattern, runs of `%`, and `%` or `_` at the ends.
        assert!(sql_like("", ""));
        assert!(sql_like("", "%"));
        assert!(sql_like("", "%%%"));
        assert!(!sql_like("", "_"));
        assert!(!sql_like("a", ""));
        assert!(sql_like("abc", "%%b%%"));
        assert!(sql_like("abc", "%c"));
        assert!(!sql_like("abc", "%d"));
        assert!(sql_like("abc", "a%c"));
        assert!(sql_like("ac", "a%c"));
        assert!(!sql_like("abx", "a%c"));
        assert!(sql_like("abc", "___"));
        assert!(!sql_like("abc", "____"));
        assert!(!sql_like("abc", "__"));
        // `_` counts characters, not bytes; `%` runs over multibyte text.
        assert!(sql_like("日本語", "___"));
        assert!(sql_like("日本語", "日%語"));
        assert!(!sql_like("日本語", "____"));
        // A backslash makes the next character literal, wildcards included, and `\\` is one backslash.
        assert!(sql_like("a%b", "a\\%b"));
        assert!(!sql_like("axb", "a\\%b"));
        assert!(sql_like("a_b", "a\\_b"));
        assert!(!sql_like("axb", "a\\_b"));
        assert!(sql_like("a\\b", "a\\\\b"));
        assert!(sql_like("ab", "a\\b"));
        assert!(sql_like("a%b%c", "a\\%b\\%c"));
        // A literal needed after `%` is found after a wrong early try (the matcher must back up to the last `%`).
        assert!(sql_like("aab", "%ab"));
        assert!(sql_like("xaab", "%a_b"));
        assert!(!sql_like("xaxab", "%a_b"));
        assert!(sql_like("mississippi", "%iss%ppi"));
        assert!(!sql_like("mississippi", "%iss%ppx"));
        // An escape with nothing after it matches nothing.
        assert!(!sql_like("a", "a\\"));
        assert!(!sql_like("a\\", "a\\"));
        assert!(!sql_like("ab", "%\\"));
    }

    /// The matcher agrees with the backtracking definition of LIKE on every small text and pattern.
    #[test]
    fn like_agrees_with_the_recursive_definition_on_small_inputs() {
        fn reference(t: &[char], p: &[char]) -> bool {
            match p.first() {
                None => t.is_empty(),
                Some('%') => (0..=t.len()).any(|i| reference(&t[i..], &p[1..])),
                Some('_') => !t.is_empty() && reference(&t[1..], &p[1..]),
                Some('\\') => match p.get(1) {
                    None => false,
                    Some(c) => t.first() == Some(c) && reference(&t[1..], &p[2..]),
                },
                Some(c) => t.first() == Some(c) && reference(&t[1..], &p[1..]),
            }
        }
        fn all(alphabet: &[char], max: usize) -> Vec<Vec<char>> {
            let mut out = vec![Vec::new()];
            let mut level = vec![Vec::new()];
            for _ in 0..max {
                level = level
                    .iter()
                    .flat_map(|s: &Vec<char>| {
                        alphabet.iter().map(move |c| {
                            let mut n = s.clone();
                            n.push(*c);
                            n
                        })
                    })
                    .collect();
                out.extend(level.iter().cloned());
            }
            out
        }
        let texts = all(&['a', 'b', '%', '\\'], 5);
        let patterns = all(&['a', 'b', '%', '_', '\\'], 5);
        for p in &patterns {
            let pattern: String = p.iter().collect();
            for t in &texts {
                let text: String = t.iter().collect();
                assert_eq!(
                    sql_like(&text, &pattern),
                    reference(t, p),
                    "{text:?} LIKE {pattern:?}"
                );
            }
        }
    }

    #[test]
    fn like_follows_postgres() {
        // PGLite: 'a/x' / 'ab/x' / 'a%/x' / 'a\/x' against each pattern.
        let texts = ["a/x", "ab/x", "a%/x", "a\\/x"];
        let cases: [(&str, [bool; 4]); 5] = [
            ("a\\/%", [true, false, false, false]),
            ("a_/%", [false, true, true, true]),
            ("a\\%/%", [false, false, true, false]),
            ("a%", [true, true, true, true]),
            ("a\\\\/%", [false, false, false, true]),
        ];
        for (pattern, want) in cases {
            for (text, w) in texts.iter().zip(want) {
                assert_eq!(sql_like(text, pattern), w, "{text:?} LIKE {pattern:?}");
            }
        }
        assert!(sql_like("people/é", "people/%"));
        assert!(sql_like("é", "_"));
        assert!(!sql_like("people", "people/%"));
    }

    #[test]
    fn ilike_lowers_both_sides_first() {
        // Postgres (en_US.utf8) and PGLite (C.UTF-8) agree on each of these.
        assert!(sql_ilike("people/ada", "%ADA%"));
        assert!(sql_ilike("Ä", "ä"));
        assert!(sql_ilike("notes/a_b", "%A\\_B"));
        assert!(!sql_ilike("notes/axb", "%A\\_B"));
        assert!(!sql_ilike("people/adam", "%ADA"));
    }

    fn put(store: &Store, slug: &str, title: &str) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": title, "compiled_truth": "body", "timeline": ""
        }))
        .unwrap();
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    #[test]
    fn the_best_title_wins_ties_go_to_the_lower_slug_and_scope_filters_apply() {
        let store = crate::test_support::store();
        put(&store, "people/bob", "Alice Example");
        put(&store, "people/alice", "Alice Example");
        put(&store, "companies/acme", "Alice Exampl");
        put(&store, "people/zed", "Unrelated");
        let found = |name: &str, dir: Option<&str>, min: Option<f64>, src: Option<&str>| {
            store.find_by_title_fuzzy(name, dir, min, src).unwrap()
        };
        let hit = found("alice example", None, None, None);
        assert_eq!(hit["slug"], "people/alice");
        assert_eq!(hit["similarity"], 1.0);
        assert_eq!(
            found("alice exampl", Some("companies"), None, None)["slug"],
            "companies/acme"
        );
        assert_eq!(
            found("alice example", Some("people"), Some(1.5), None),
            Value::Null
        );
        assert_eq!(found("zzz", None, None, None), Value::Null);
        assert_eq!(
            found("alice example", None, None, Some("other")),
            Value::Null
        );
        // An empty sourceId or dirPrefix is no scope.
        assert_eq!(
            found("alice example", Some(""), None, Some(""))["slug"],
            "people/alice"
        );
        // Soft-deleted pages: hidden from the scoped arm, still read by the unscoped arm.
        store.soft_delete_page("people/alice", None).unwrap();
        assert_eq!(
            found("alice example", None, None, Some("default"))["slug"],
            "people/bob"
        );
        assert_eq!(
            found("alice example", None, None, None)["slug"],
            "people/alice"
        );
    }

    #[test]
    fn a_real_parameter_rounds_once_and_refuses_out_of_range() {
        assert_eq!(real_param(0.33333334).unwrap(), 1.0f32 / 3.0);
        assert!(real_param(1e300).is_err());
        assert!(real_param(1e-50).is_err());
        assert!(real_param(f64::NAN).unwrap().is_nan());
        assert_eq!(real_param(f64::NEG_INFINITY).unwrap(), f32::NEG_INFINITY);
        assert_eq!(real_to_js(1.0f32 / 3.0), 0.33333334);
    }

    /// Every score `calc_sml(c, n1, n2) >= min` has `c >= min_shared(n1, min)`. The bound needs
    /// only `n1` and `min` and rises with `min`, so the hardest `min` for a `(c, n1, n2)` is its
    /// own score: checking that covers every lower threshold.
    fn admitted(c: usize, n1: usize, n2: usize) {
        let s = super::super::trgm::calc_sml(c, n1, n2);
        if let Some(need) = min_shared(n1, s) {
            assert!(c >= need, "c {c} n1 {n1} n2 {n2} score {s} need {need}");
        }
    }

    /// Every `(c, n1, n2)` with `n1, n2 <= 2,048`. The score falls as `n2` grows (a correctly
    /// rounded division is monotone in its divisor), so `n2 = c` has the highest score of each
    /// `(c, n1)`; that case runs for every pair, and every `n2` runs for `n1 <= 192` and for the
    /// largest `n1` values.
    #[test]
    fn the_trigram_bound_admits_every_title_that_reaches_the_threshold() {
        for n1 in 1..=BOUND_TRIGRAMS {
            let every_n2 = n1 <= 192 || n1 > BOUND_TRIGRAMS - 8;
            for c in 1..=n1 {
                admitted(c, n1, c);
                if every_n2 {
                    for n2 in c..=BOUND_TRIGRAMS {
                        admitted(c, n1, n2);
                    }
                }
            }
        }
        // The divisor monotonicity the reduction rests on, over a band of numerators.
        for c in [1usize, 2, 3, 7, 1_000, 2_048] {
            let mut last = f32::INFINITY;
            for d in c..=2 * BOUND_TRIGRAMS {
                let s = c as f32 / d as f32;
                assert!(s <= last);
                last = s;
            }
        }
        // A title sharing no trigram has score 0 and is never needed.
        assert_eq!(min_shared(10, 0.0), None);
        assert_eq!(min_shared(10, -1.0), None);
        assert_eq!(min_shared(10, f32::NAN), None);
        assert_eq!(min_shared(10, f32::INFINITY), None);
        assert_eq!(min_shared(BOUND_TRIGRAMS + 1, 0.9), Some(1));
        assert_eq!(min_shared(0, 0.5), Some(1));
        assert_eq!(min_shared(10, f32::from_bits(1)), Some(1));
    }

    /// The review's case: a score of exactly the rounded threshold, which a bound of
    /// `ceil(n1 * min)` would drop.
    #[test]
    fn a_score_equal_to_the_rounded_threshold_is_admitted() {
        let min = real_param(0.200000001).unwrap();
        let (c, n1) = (2, 10);
        assert_eq!(super::super::trgm::calc_sml(c, n1, 2), min);
        assert!((n1 as f64 * f64::from(min)).ceil() as usize > c);
        assert_eq!(min_shared(n1, min), Some(2));
    }
}
