//! The CJK keyword fallback of `searchKeyword` and `searchKeywordChunks`
//! (`search/cjk-keyword-sql.ts` and `engine-sql/cjk-search.ts`, as PGLite runs them), and the
//! term matcher the CJK page members share (`keyword/page_search.rs`).
//!
//! `websearch_to_tsquery('english', ...)` cannot split CJK text, so on a query holding a CJK
//! character the SQL engines match the chunk text term by term instead. The TypeScript member
//! sends the terms (`cjkMatchTerms`: whitespace split, Korean particles stripped, deduplicated)
//! with their operator: `LIKE` for a term whose `toLowerCase()` equals its `toUpperCase()`, else
//! `ILIKE`. Each pattern is `%term%` with the term escaped, so a term matches as a plain substring;
//! `ILIKE` lowers both sides per character (`pg_lower`, PGLite's `C.UTF-8` table).
//!
//! ```sql
//! score = ((Σ count(t, term_i) [+ count(t, $q) when more than one term]
//!           + COALESCE(1.0 / NULLIF(POSITION($q IN t), 0)::real, 0.0)) * <source factor>)
//! ```
//!
//! `count(t, x)` is `(LENGTH(t) - LENGTH(REPLACE(t, x, ''))) / LENGTH(x)::real`: the
//! non-overlapping, case-sensitive occurrences, an exact whole number in `double precision`. `$q`
//! is the raw query (no dash-run collapse) and `POSITION` is 1-based in characters; the reciprocal
//! is taken of the `real` position, so it is `1.0 / (pos as f32)` widened.
//!
//! Strict (`match: 'all'`): every term matches, ordered by score. The OR fallback
//! (`match: 'any'`, more than one term): any term matches, the score is
//! `1000 * matched + score`, ordered by the matched count, then score. Both break ties by page id,
//! then chunk id. `searchKeyword` (`dedup`) also keeps `modality = 'text'` chunks only, takes the
//! first `innerLimit` chunks in that order, keeps each page's best chunk (score, then page id,
//! then chunk id), orders by score, page id and chunk id, and applies `OFFSET` and `LIMIT`.
//! `searchKeywordChunks` applies `OFFSET` and `LIMIT` to the chunk order.
//!
//! `orFallback` (`opts.orFallback` with more than one whitespace term): when the strict rows fall
//! short of the limit, the OR variant answers instead.
//!
//! The bounded arm (`opts.cjkKeyword`) follows PGLite's rule, bounded by work: up to
//! `cappedChunks` chunks the full scoring answers; past it the capped stage does. PGLite reads the
//! planner's estimate (`pg_class.reltuples`, -1 before the table is analyzed); this store reads its
//! exact chunk count (every page, deleted or not). The capped stage takes up to `cap` all-term
//! chunk ids, scores the strict variant over them, and, when the OR fallback applies and the
//! all-term rows fall short, adds up to the remaining room of partial-match ids and scores the OR
//! variant over both. PGLite's candidate scan is unordered (heap order, which is insertion order
//! on a table that only grows); this store takes candidates in ascending chunk id, the order the
//! chunks were inserted.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::filters::{KeywordOptions, PageFilter, result_row, row_count, source_factor};
use super::walk::{Admit, walk_text_chunks};
use crate::Store;
use crate::chunks::{ChunkRecord, read_stats};
use crate::cli_reads::pg_text::pg_lower;
use crate::error::Result;
use crate::pages::PageRecord;
use crate::timeline::latest_entry_micros;

/// `MATCHED_TERM_WEIGHT`: the OR fallback's weight on the matched-term count.
const MATCHED_TERM_WEIGHT: u64 = 1000;

/// One CJK match term, as `cjkMatchTerms` returns it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CjkTerm {
    pub text: String,
    /// `ILIKE` (the term has case); `false` is `LIKE`.
    pub ilike: bool,
}

/// The bounded arm's work bound (`opts.cjkKeyword`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CjkBound {
    /// `candidateCap ?? CJK_CANDIDATE_CAP`.
    pub cap: f64,
    /// `pgliteCappedChunks ?? PGLITE_CJK_CAPPED_CHUNKS`: the full scoring answers up to this many
    /// chunks.
    pub capped_chunks: f64,
}

/// What one CJK keyword call runs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CjkRun {
    pub terms: Vec<CjkTerm>,
    /// `searchKeyword` (page grain, text chunks only); `false` is `searchKeywordChunks`.
    pub dedup: bool,
    /// The OR fallback applies (`orFallback` and more than one whitespace term).
    #[serde(default)]
    pub or_fallback: bool,
    /// The bounded arm; `None` is the full scoring with no report.
    #[serde(default)]
    pub bounded: Option<CjkBound>,
}

/// The rows, and what the bounded arm did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CjkKeywordResult {
    pub rows: Vec<Value>,
    /// The capped stage served the rows.
    pub capped: bool,
    /// The capped stage stopped at its candidate cap.
    pub cap_hit: bool,
}

/// The terms with their lowered `ILIKE` patterns.
pub(super) struct CjkMatcher<'a> {
    terms: &'a [CjkTerm],
    lowered: Vec<Option<String>>,
}

impl<'a> CjkMatcher<'a> {
    pub(super) fn new(terms: &'a [CjkTerm]) -> Self {
        Self {
            terms,
            lowered: terms
                .iter()
                .map(|t| t.ilike.then(|| pg_lower(&t.text)))
                .collect(),
        }
    }

    /// How many terms `text` matches.
    pub(super) fn matched(&self, text: &str) -> usize {
        let mut lowered_text: Option<String> = None;
        let mut n = 0;
        for (term, lowered) in self.terms.iter().zip(&self.lowered) {
            let hit = match lowered {
                None => text.contains(term.text.as_str()),
                Some(pattern) => lowered_text
                    .get_or_insert_with(|| pg_lower(text))
                    .contains(pattern.as_str()),
            };
            n += usize::from(hit);
        }
        n
    }

    /// Every term matches (the strict `AND`; no terms match nothing).
    pub(super) fn all(&self, text: &str) -> bool {
        !self.terms.is_empty() && self.matched(text) == self.terms.len()
    }

    /// `Σ count(t, term_i)`: the page members' rank, before the source factor.
    pub(super) fn term_counts(&self, text: &str) -> u64 {
        self.terms.iter().map(|t| occurrences(text, &t.text)).sum()
    }
}

/// `(LENGTH(t) - LENGTH(REPLACE(t, x, ''))) / LENGTH(x)`: the non-overlapping occurrences.
fn occurrences(text: &str, needle: &str) -> u64 {
    if needle.is_empty() {
        return 0;
    }
    text.matches(needle).count() as u64
}

/// `COALESCE(1.0 / NULLIF(POSITION(q IN t), 0)::real, 0.0)`.
fn position_term(text: &str, query: &str) -> f64 {
    match text.find(query) {
        Some(byte) => 1.0 / f64::from((text[..byte].chars().count() + 1) as f32),
        None => 0.0,
    }
}

/// A chunk that matches at least one term.
struct Hit {
    page: usize,
    page_id: u64,
    chunk: ChunkRecord,
    matched: usize,
    /// The strict score, source factor applied.
    score: f64,
}

/// How a scoring statement ranks and windows its rows.
struct Window {
    dedup: bool,
    inner_limit: usize,
    limit: usize,
    offset: usize,
}

impl Store {
    /// The CJK fallback of `searchKeyword` (`run.dedup`) and `searchKeywordChunks`. `query` is
    /// the raw query; `options` carry the resolved filters and the window (`limit`, `offset`,
    /// `innerLimit`).
    pub fn search_keyword_cjk(
        &self,
        query: &str,
        options: &KeywordOptions,
        run: &CjkRun,
    ) -> Result<CjkKeywordResult> {
        let limit = row_count(options.limit.unwrap_or(20.0), "LIMIT")?;
        let offset = row_count(options.offset.unwrap_or(0.0), "OFFSET")?;
        let inner_limit = if run.dedup {
            row_count(options.inner_limit.unwrap_or((limit * 3) as f64), "LIMIT")?
        } else {
            0
        };
        let cap = run
            .bounded
            .as_ref()
            .map(|b| row_count(b.cap, "LIMIT"))
            .transpose()?;
        let empty = CjkKeywordResult {
            rows: Vec::new(),
            capped: false,
            cap_hit: false,
        };
        if query.is_empty() || run.terms.is_empty() {
            return Ok(empty);
        }
        let window = Window {
            dedup: run.dedup,
            inner_limit,
            limit,
            offset,
        };
        let any_variant = run.terms.len() > 1;
        let matcher = CjkMatcher::new(&run.terms);
        let read = self.read()?;
        let capped = match (&run.bounded, cap) {
            (Some(bound), Some(_)) => read_stats(&*read)?.chunks as f64 > bound.capped_chunks,
            _ => false,
        };
        let mut filter = PageFilter::new(options)?;
        let mut admit = Admit {
            filter: Some(&mut filter),
            text_only: run.dedup,
            basenames: None,
        };
        let mut hits: Vec<Hit> = Vec::new();
        let mut pages: Vec<(PageRecord, bool)> = Vec::new();
        walk_text_chunks(&*read, &mut admit, &mut |page, chunks| {
            let mut factor: Option<f64> = None;
            let first = hits.len();
            for chunk in chunks {
                let matched = matcher.matched(&chunk.chunk_text);
                if matched == 0 {
                    continue;
                }
                let factor = *factor.get_or_insert_with(|| source_factor(&page, &options.boosts));
                let text = &chunk.chunk_text;
                let bonus = if any_variant {
                    occurrences(text, query)
                } else {
                    0
                };
                let counts = (matcher.term_counts(text) + bonus) as f64;
                hits.push(Hit {
                    page: pages.len(),
                    page_id: page.id,
                    score: (counts + position_term(text, query)) * factor,
                    chunk,
                    matched,
                });
            }
            if hits.len() > first {
                let stale = latest_entry_micros(&*read, page.id)?
                    .is_some_and(|latest| page.updated_at_us < latest);
                pages.push((page, stale));
            }
            Ok(true)
        })?;
        let all_terms = run.terms.len();
        let strict = |h: &&Hit| h.matched == all_terms;
        let rows = |ranked: Vec<(&Hit, f64)>| -> Vec<Value> {
            ranked
                .into_iter()
                .map(|(h, score)| {
                    let (page, stale) = &pages[h.page];
                    result_row(page, &h.chunk, score, *stale)
                })
                .collect()
        };
        if !capped {
            let strict_rows = rank(hits.iter().filter(strict).collect(), false, &window);
            let ranked = if run.or_fallback && strict_rows.len() < limit {
                rank(hits.iter().collect(), any_variant, &window)
            } else {
                strict_rows
            };
            return Ok(CjkKeywordResult {
                rows: rows(ranked),
                ..empty
            });
        }
        let cap = cap.unwrap_or(0);
        let mut by_id: Vec<&Hit> = hits.iter().collect();
        by_id.sort_by_key(|h| h.chunk.id);
        let all: Vec<&Hit> = by_id.iter().copied().filter(strict).take(cap).collect();
        let strict_rows = rank(all.clone(), false, &window);
        if all.len() >= cap || !run.or_fallback || strict_rows.len() >= limit {
            return Ok(CjkKeywordResult {
                rows: rows(strict_rows),
                capped: true,
                cap_hit: all.len() >= cap,
            });
        }
        // `all` is short of the cap, so it holds every all-term chunk: the partial candidates are
        // the chunks the candidate statement's `OR` admits beyond it (none for a single term).
        let room = cap - all.len();
        let partial: Vec<&Hit> = by_id
            .iter()
            .copied()
            .filter(|h| any_variant && h.matched < all_terms)
            .take(room)
            .collect();
        if partial.is_empty() {
            return Ok(CjkKeywordResult {
                rows: rows(strict_rows),
                capped: true,
                cap_hit: false,
            });
        }
        let cap_hit = partial.len() >= room;
        let candidates: Vec<&Hit> = all.into_iter().chain(partial).collect();
        Ok(CjkKeywordResult {
            rows: rows(rank(candidates, any_variant, &window)),
            capped: true,
            cap_hit,
        })
    }
}

/// One scoring statement over `hits`: the variant's score and order, then the window.
fn rank<'h>(hits: Vec<&'h Hit>, any: bool, window: &Window) -> Vec<(&'h Hit, f64)> {
    let score = |h: &Hit| {
        if any {
            (MATCHED_TERM_WEIGHT * h.matched as u64) as f64 + h.score
        } else {
            h.score
        }
    };
    let mut scored: Vec<(&Hit, f64)> = hits.into_iter().map(|h| (h, score(h))).collect();
    let by_score = |a: &(&Hit, f64), b: &(&Hit, f64)| {
        b.1.total_cmp(&a.1)
            .then(a.0.page_id.cmp(&b.0.page_id))
            .then(a.0.chunk.id.cmp(&b.0.chunk.id))
    };
    scored.sort_by(|a, b| {
        let matched = if any {
            b.0.matched.cmp(&a.0.matched)
        } else {
            std::cmp::Ordering::Equal
        };
        matched.then_with(|| by_score(a, b))
    });
    if window.dedup {
        scored.truncate(window.inner_limit);
        // DISTINCT ON (source, slug): one page per (source, slug), so per page id.
        scored.sort_by(|a, b| a.0.page_id.cmp(&b.0.page_id).then_with(|| by_score(a, b)));
        scored.dedup_by_key(|(h, _)| h.page_id);
        scored.sort_by(by_score);
    }
    scored
        .into_iter()
        .skip(window.offset)
        .take(window.limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(store: &Store, slug: &str, body: &str, timeline: &str) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": body, "timeline": timeline,
            "frontmatter": {},
        }))
        .unwrap();
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    fn terms(query: &str) -> Vec<CjkTerm> {
        query
            .split_whitespace()
            .map(|t| CjkTerm {
                text: t.to_string(),
                ilike: t.to_lowercase() != t.to_uppercase(),
            })
            .collect()
    }

    fn run(query: &str, dedup: bool, or_fallback: bool, bounded: Option<(f64, f64)>) -> CjkRun {
        CjkRun {
            terms: terms(query),
            dedup,
            or_fallback,
            bounded: bounded.map(|(cap, capped_chunks)| CjkBound { cap, capped_chunks }),
        }
    }

    fn opts(v: Value) -> KeywordOptions {
        serde_json::from_value(v).unwrap()
    }

    fn search(store: &Store, query: &str, o: Value, r: &CjkRun) -> CjkKeywordResult {
        store.search_keyword_cjk(query, &opts(o), r).unwrap()
    }

    fn hits(result: &CjkKeywordResult) -> Vec<(String, f64)> {
        result
            .rows
            .iter()
            .map(|r| {
                (
                    r["slug"].as_str().unwrap().to_string(),
                    r["score"].as_f64().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn strict_needs_every_term_and_scores_counts_bonus_and_position() {
        let store = crate::test_support::store();
        put(&store, "notes/both", "東京と大阪と東京", "");
        put(&store, "notes/one", "ここは東京", "");
        put(&store, "notes/phrase", "東京 大阪", "");
        put(&store, "notes/none", "nothing", "");

        // Two terms: the counts, the raw-query bonus, then the position of the raw query.
        let both = search(
            &store,
            "東京 大阪",
            json!({}),
            &run("東京 大阪", true, false, None),
        );
        assert_eq!(
            hits(&both),
            [
                ("notes/phrase".to_string(), 1.0 + 1.0 + 1.0 + 1.0),
                ("notes/both".to_string(), 2.0 + 1.0),
            ]
        );
        // One term: no bonus; the position is 1-based in characters, through a `real`.
        let one = search(&store, "東京", json!({}), &run("東京", false, false, None));
        let expected = |count: f64, pos: f32| count + 1.0 / f64::from(pos);
        assert_eq!(
            hits(&one),
            [
                ("notes/both".to_string(), expected(2.0, 1.0)),
                ("notes/phrase".to_string(), expected(1.0, 1.0)),
                ("notes/one".to_string(), expected(1.0, 4.0)),
            ]
        );
        assert!(
            search(&store, "", json!({}), &run("東京", true, false, None))
                .rows
                .is_empty()
        );
    }

    #[test]
    fn the_or_fallback_ranks_by_matched_terms_and_only_runs_when_strict_falls_short() {
        let store = crate::test_support::store();
        put(&store, "notes/both", "東京と大阪", "");
        put(&store, "notes/one", "東京 東京 東京 東京", "");
        let q = "東京 大阪";
        let strict = search(
            &store,
            q,
            json!({ "limit": 1.0 }),
            &run(q, true, true, None),
        );
        assert_eq!(hits(&strict), [("notes/both".to_string(), 2.0)]);
        let any = search(
            &store,
            q,
            json!({ "limit": 5.0 }),
            &run(q, true, true, None),
        );
        assert_eq!(
            hits(&any),
            [
                ("notes/both".to_string(), 2000.0 + 2.0),
                ("notes/one".to_string(), 1000.0 + 4.0),
            ]
        );
        // Without the fallback the strict rows stand.
        let plain = search(
            &store,
            q,
            json!({ "limit": 5.0 }),
            &run(q, true, false, None),
        );
        assert_eq!(hits(&plain).len(), 1);
    }

    #[test]
    fn a_cased_term_matches_with_ilike_and_counts_case_sensitively() {
        let store = crate::test_support::store();
        put(&store, "notes/lower", "tokyo東京 Tokyo東京", "");
        put(&store, "notes/upper", "TOKYO東京", "");
        let q = "Tokyo東京";
        let rows = search(&store, q, json!({}), &run(q, false, false, None));
        // ILIKE admits both pages; REPLACE and POSITION count only the exact spelling.
        assert_eq!(
            hits(&rows),
            [
                ("notes/lower".to_string(), 1.0 + 1.0 / 9.0f32 as f64),
                ("notes/upper".to_string(), 0.0),
            ]
        );
        // A term without case uses LIKE, which does not fold.
        let caseless = vec![CjkTerm {
            text: "Tokyo東京".to_string(),
            ilike: false,
        }];
        let like = CjkRun {
            terms: caseless,
            ..run(q, false, false, None)
        };
        assert_eq!(hits(&search(&store, q, json!({}), &like)).len(), 1);
    }

    #[test]
    fn dedup_keeps_each_page_best_chunk_and_chunk_grain_keeps_every_chunk() {
        let store = crate::test_support::store();
        put(&store, "notes/two", "東京", "- 2024-01-01: 東京 東京");
        put(&store, "notes/other", "東京 東京 東京", "");
        let q = "東京";
        let chunks = search(&store, q, json!({}), &run(q, false, false, None));
        let pages = search(&store, q, json!({}), &run(q, true, false, None));
        let slugs =
            |r: &CjkKeywordResult| -> Vec<String> { hits(r).into_iter().map(|h| h.0).collect() };
        assert!(chunks.rows.len() > pages.rows.len(), "{:?}", hits(&chunks));
        assert_eq!(slugs(&pages), ["notes/other", "notes/two"]);
        // The window applies after the per-page pass.
        let second = search(
            &store,
            q,
            json!({ "offset": 1.0 }),
            &run(q, true, false, None),
        );
        assert_eq!(slugs(&second), ["notes/two"]);
    }

    #[test]
    fn the_capped_stage_takes_candidates_by_chunk_id_and_reports_the_cap() {
        let store = crate::test_support::store();
        put(&store, "notes/first", "東京", "");
        put(&store, "notes/second", "東京 東京 東京", "");
        let q = "東京";
        // At or under the chunk bound the full scoring answers.
        let full = search(
            &store,
            q,
            json!({}),
            &run(q, true, false, Some((1.0, 50_000.0))),
        );
        assert_eq!(
            (full.capped, full.cap_hit, full.rows.len()),
            (false, false, 2)
        );
        // Past it: one candidate, the lowest chunk id, and the cap is reported.
        let capped = search(&store, q, json!({}), &run(q, true, false, Some((1.0, 0.0))));
        assert_eq!((capped.capped, capped.cap_hit), (true, true));
        assert_eq!(hits(&capped)[0].0, "notes/first");
        let roomy = search(
            &store,
            q,
            json!({}),
            &run(q, true, false, Some((10.0, 0.0))),
        );
        assert_eq!(
            (roomy.capped, roomy.cap_hit, roomy.rows.len()),
            (true, false, 2)
        );
        // The OR fallback fills the remaining room with partial matches.
        put(&store, "notes/osaka", "大阪", "");
        let q2 = "東京 大阪";
        let partial = search(
            &store,
            q2,
            json!({}),
            &run(q2, true, true, Some((10.0, 0.0))),
        );
        assert_eq!(
            (partial.capped, partial.cap_hit, partial.rows.len()),
            (true, false, 3)
        );
        let tight = search(
            &store,
            q2,
            json!({}),
            &run(q2, true, true, Some((2.0, 0.0))),
        );
        assert_eq!(
            (tight.capped, tight.cap_hit, tight.rows.len()),
            (true, true, 2)
        );
        assert!(
            store
                .search_keyword_cjk(q, &opts(json!({})), &run(q, true, false, Some((1.5, 0.0))))
                .is_err()
        );
    }

    #[test]
    fn the_page_members_and_the_terms_together() {
        let store = crate::test_support::store();
        put(&store, "notes/both", "東京と大阪と東京", "");
        put(&store, "notes/one", "東京", "");
        let o = |q: &str| {
            opts(
                json!({ "cjkTerms": terms(q).iter().map(|t| json!({ "text": t.text, "ilike": t.ilike })).collect::<Vec<_>>() }),
            )
        };
        assert_eq!(
            store
                .count_keyword_pages("東京 大阪", &o("東京 大阪"))
                .unwrap(),
            1
        );
        assert_eq!(store.count_keyword_pages("東京", &o("東京")).unwrap(), 2);
        let rows = store.search_keyword_pages("東京", &o("東京")).unwrap();
        let scores: Vec<f64> = rows.iter().map(|r| r["score"].as_f64().unwrap()).collect();
        // The page rank is the term counts alone: no bonus, no position.
        assert_eq!(scores, [2.0, 1.0]);
        let none = opts(json!({ "cjkTerms": [] }));
        assert_eq!(store.count_keyword_pages("東京", &none).unwrap(), 0);
    }
}
