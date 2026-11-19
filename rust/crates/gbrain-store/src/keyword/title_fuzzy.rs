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

use super::trgm::{TRGM_SIMILARITY_THRESHOLD, trgm_similarity};
use crate::Store;
use crate::cli_reads::pg_text::pg_lower;
use crate::error::{Result, StoreError};
use crate::pages::all_pages;
use serde_json::{Value, json};

/// `findByTitleFuzzy`'s default `minSimilarity`.
pub(crate) const DEFAULT_MIN_SIMILARITY: f64 = 0.55;

/// SQL `LIKE` with the default escape character `\`: `%` matches any run of characters, `_` one
/// character, and `\x` the character `x`. A trailing lone `\` matches nothing, as in PG 18 when
/// the text is used up first (the patterns built here never end in one).
pub(crate) fn sql_like(text: &str, pattern: &str) -> bool {
    fn go(t: &[char], p: &[char]) -> bool {
        let (mut ti, mut pi) = (0, 0);
        while pi < p.len() {
            match p[pi] {
                '%' => {
                    while pi < p.len() && p[pi] == '%' {
                        pi += 1;
                    }
                    if pi == p.len() {
                        return true;
                    }
                    return (ti..=t.len()).any(|start| go(&t[start..], &p[pi..]));
                }
                '_' => {
                    if ti == t.len() {
                        return false;
                    }
                    ti += 1;
                    pi += 1;
                }
                c => {
                    let lit = if c == '\\' {
                        pi += 1;
                        match p.get(pi) {
                            Some(&n) => n,
                            None => return false,
                        }
                    } else {
                        c
                    };
                    if t.get(ti) != Some(&lit) {
                        return false;
                    }
                    ti += 1;
                    pi += 1;
                }
            }
        }
        ti == t.len()
    }
    let t: Vec<char> = text.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    go(&t, &p)
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
        for page in all_pages(&*read)? {
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
}
