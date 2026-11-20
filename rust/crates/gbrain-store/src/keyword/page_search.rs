//! `countKeywordPages(query, opts?)` and `searchKeywordPages(query, opts, page)`: the strict
//! keyword match of `search/keyword-statement.ts`, one row per page.
//!
//! Two arms under the same `keywordFilters` (page filters, chunk filters, visibility and
//! `cc.modality = 'text'`):
//!
//! - text: `cc.search_vector @@ websearch_to_tsquery('english', $q)`, scored
//!   `((ts_rank(v, q) * phrase) * factor)::float8`;
//! - handle (only when the query has slug handles): every chunk of a page whose slug basename is a
//!   handle, scored `((1 + ts_rank(v, q) * phrase) * factor)::float8`.
//!
//! `phrase` is 2 when `keywordPhrase` is on and the chunk matches `phraseto_tsquery($q)`, else 1.
//! The count is the distinct pages of both arms, capped at `KEYWORD_COUNT_CAP + 1`. The pages
//! keep each page's best chunk (highest score, then lowest chunk id), apply the keyset
//! `score < s OR (score = s AND page_id > p)`, order by score descending and page id, and take
//! `LIMIT $limit OFFSET $offset` without clamping. The query is the raw one (no dash-run
//! collapse), and `stale` is always false, as `keyword-statement.ts` reports on both SQL
//! engines (Postgres reads no `timeline_entries` here). With `handlesOnly` only the handle arm runs
//! (`searchHandlePages`, the keyword arm's rows for the pages a slug handle names).
//!
//! A CJK query (`cjkTerms` set) runs `buildKeywordMatch`'s CJK arm instead: a text chunk matches
//! when it holds every term (LIKE, or ILIKE for a term with case), scored
//! `((Σ term occurrences) * factor)::float8`; no handle arm, and `handlesOnly` matches nothing.

use std::collections::{BTreeMap, BTreeSet};

use super::cjk::{CjkMatcher, CjkTerm};
use super::filters::{KeywordOptions, PageFilter, result_row, row_count, source_factor};
use super::index::{basename, basename_pages};
use super::rank::ts_rank;
use super::tsearch::{
    TsQuery, phraseto_tsquery, ts_matches, websearch_to_tsquery, with_query_stack,
};
use super::walk::{Admit, ChunkSource, PageOrder, walk_chunks, walk_text_chunks};
use crate::Store;
use crate::chunks::ChunkRecord;
use crate::error::{Result, StoreError};
use crate::pages::PageRecord;
use crate::timeline::latest_entry_micros;
use serde_json::Value;

/// `KEYWORD_COUNT_CAP` (search/keyword-statement.ts).
const KEYWORD_COUNT_CAP: usize = 10_000;

/// `KEYWORD_PHRASE_FACTOR` (search/sql-ranking.ts).
const KEYWORD_PHRASE_FACTOR: f64 = 2.0;

/// A page's best matching chunk, and whether the page is stale (only read when asked for).
struct Best {
    score: f64,
    chunk: ChunkRecord,
    stale: bool,
}

struct Matcher {
    query: TsQuery,
    phrase: Option<TsQuery>,
}

impl Store {
    /// Visits every page that matches with its best chunk; `visit` returns false to stop.
    /// `with_stale` reads each matched page's newest timeline entry for `Best::stale`.
    fn keyword_pages(
        &self,
        query: &str,
        options: &KeywordOptions,
        with_stale: bool,
        mut visit: impl FnMut(PageRecord, Best) -> bool + Send,
    ) -> Result<()> {
        if query.trim().is_empty() {
            return Ok(());
        }
        if let Some(terms) = &options.cjk_terms {
            return self.cjk_keyword_pages(terms, options, with_stale, visit);
        }
        let matcher = Matcher {
            query: websearch_to_tsquery(query)?,
            phrase: if options.phrase {
                Some(phraseto_tsquery(query)?)
            } else {
                None
            },
        };
        // One deep-stack thread for the whole walk when the query is deep (see with_query_stack).
        let items = matcher
            .query
            .items
            .len()
            .max(matcher.phrase.as_ref().map_or(0, |p| p.items.len()));
        with_query_stack(items, || {
            let read = self.read()?;
            let mut filter = PageFilter::new(options)?;
            let text_queries: Vec<&TsQuery> = if options.handles_only {
                Vec::new()
            } else {
                vec![&matcher.query]
            };
            let mut extra: Vec<&TsQuery> = vec![&matcher.query];
            extra.extend(matcher.phrase.as_ref());
            let source = ChunkSource::plan(&*read, &text_queries, &extra, |read| {
                if options.handles.is_empty() {
                    Ok(Some(BTreeSet::new()))
                } else {
                    basename_pages(read, &options.handles)
                }
            })?;
            let mut admit = Admit {
                filter: Some(&mut filter),
                text_only: true,
                basenames: options.handles_only.then_some(&options.handles[..]),
            };
            walk_chunks(
                &*read,
                &source,
                PageOrder::Any,
                &mut admit,
                &mut |page, chunks| {
                    let handle = options.handles.iter().any(|h| h == basename(&page.slug));
                    let mut factor: Option<f64> = None;
                    let mut best: Option<Best> = None;
                    for (chunk, vector) in chunks {
                        let text = !options.handles_only && ts_matches(&vector, &matcher.query);
                        if !text && !handle {
                            continue;
                        }
                        let factor =
                            *factor.get_or_insert_with(|| source_factor(&page, &options.boosts));
                        let phrase = match &matcher.phrase {
                            Some(p) if ts_matches(&vector, p) => KEYWORD_PHRASE_FACTOR,
                            _ => 1.0,
                        };
                        let rank = f64::from(ts_rank(&vector, &matcher.query)) * phrase;
                        // A chunk in both arms keeps its higher score: the handle arm's.
                        let score = if handle {
                            (1.0 + rank) * factor
                        } else {
                            rank * factor
                        };
                        let better = best.as_ref().is_none_or(|b| {
                            score > b.score || (score == b.score && chunk.id < b.chunk.id)
                        });
                        if better {
                            best = Some(Best {
                                score,
                                chunk,
                                stale: false,
                            });
                        }
                    }
                    let Some(mut best) = best else {
                        return Ok(true);
                    };
                    if with_stale {
                        best.stale = latest_entry_micros(&*read, page.id)?
                            .is_some_and(|latest| page.updated_at_us < latest);
                    }
                    Ok(visit(page, best))
                },
            )?;
            Ok(())
        })
    }

    /// `keyword_pages` on a CJK query (`buildKeywordMatch`'s CJK arm): every term matches the text
    /// chunk (`LIKE` / `ILIKE`), scored `((Σ count(t, term_i)) * factor)::float8`, with no
    /// handle arm, so a handles-only call matches nothing.
    fn cjk_keyword_pages(
        &self,
        terms: &[CjkTerm],
        options: &KeywordOptions,
        with_stale: bool,
        mut visit: impl FnMut(PageRecord, Best) -> bool,
    ) -> Result<()> {
        if terms.is_empty() || options.handles_only {
            return Ok(());
        }
        let matcher = CjkMatcher::new(terms);
        let read = self.read()?;
        let mut filter = PageFilter::new(options)?;
        let mut admit = Admit {
            filter: Some(&mut filter),
            text_only: true,
            basenames: None,
        };
        walk_text_chunks(&*read, &mut admit, &mut |page, chunks| {
            let mut factor: Option<f64> = None;
            let mut best: Option<Best> = None;
            for chunk in chunks {
                if !matcher.all(&chunk.chunk_text) {
                    continue;
                }
                let factor = *factor.get_or_insert_with(|| source_factor(&page, &options.boosts));
                let score = matcher.term_counts(&chunk.chunk_text) as f64 * factor;
                let better = best
                    .as_ref()
                    .is_none_or(|b| score > b.score || (score == b.score && chunk.id < b.chunk.id));
                if better {
                    best = Some(Best {
                        score,
                        chunk,
                        stale: false,
                    });
                }
            }
            let Some(mut best) = best else {
                return Ok(true);
            };
            if with_stale {
                best.stale = latest_entry_micros(&*read, page.id)?
                    .is_some_and(|latest| page.updated_at_us < latest);
            }
            Ok(visit(page, best))
        })
    }

    /// `countKeywordPages`: the matching pages, at most `KEYWORD_COUNT_CAP + 1`.
    pub fn count_keyword_pages(&self, query: &str, options: &KeywordOptions) -> Result<u64> {
        let mut n = 0usize;
        self.keyword_pages(query, options, false, |_, _| {
            n += 1;
            n <= KEYWORD_COUNT_CAP
        })?;
        Ok(n as u64)
    }

    /// `searchKeywordPages`: one row per page, best chunk, in score order. `options.limit` absent
    /// is no limit.
    pub fn search_keyword_pages(
        &self,
        query: &str,
        options: &KeywordOptions,
    ) -> Result<Vec<Value>> {
        let limit = options.limit.map(|l| row_count(l, "LIMIT")).transpose()?;
        let offset = row_count(options.offset.unwrap_or(0.0), "OFFSET")?;
        let after = match &options.after {
            Some(a) if a.page_id.fract() != 0.0 || !a.page_id.is_finite() => {
                return Err(StoreError::invalid(format!(
                    "invalid input syntax for type bigint: \"{}\"",
                    a.page_id
                )));
            }
            Some(a) => Some((a.score, a.page_id)),
            None => None,
        };
        // Keyed by (score descending, page id) so the walk is the final order.
        let mut kept: BTreeMap<(std::cmp::Reverse<OrdF64>, u64), (PageRecord, Best)> =
            BTreeMap::new();
        self.keyword_pages(query, options, false, |page, best| {
            let passes = after
                .is_none_or(|(s, p)| best.score < s || (best.score == s && (page.id as f64) > p));
            if passes {
                kept.insert(
                    (std::cmp::Reverse(OrdF64(best.score)), page.id),
                    (page, best),
                );
            }
            true
        })?;
        Ok(kept
            .into_values()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .map(|(page, best)| result_row(&page, &best.chunk, best.score, best.stale))
            .collect())
    }
}

/// A finite score with a total order.
#[derive(Debug, Clone, Copy, PartialEq)]
struct OrdF64(f64);

impl Eq for OrdF64 {}

impl PartialOrd for OrdF64 {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for OrdF64 {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(store: &Store, slug: &str, page_type: &str, body: &str, frontmatter: Value) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": page_type, "title": slug, "compiled_truth": body, "timeline": "",
            "frontmatter": frontmatter,
        }))
        .unwrap();
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    fn opts(v: Value) -> KeywordOptions {
        serde_json::from_value(v).unwrap()
    }

    fn slugs(rows: &[Value]) -> Vec<String> {
        rows.iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    }

    fn seed() -> Store {
        let store = crate::test_support::store();
        put(
            &store,
            "notes/one",
            "note",
            "red apple",
            json!({ "status": "active" }),
        );
        put(
            &store,
            "notes/two",
            "note",
            "red apple red apple pie",
            json!({ "status": ["draft", "active"] }),
        );
        put(
            &store,
            "people/apple-example",
            "person",
            "an unrelated body",
            json!({ "cycle": 2024 }),
        );
        put(&store, "notes/three", "concept", "apple red", json!({}));
        store
    }

    #[test]
    fn a_deep_query_walks_every_page_on_one_deep_thread() {
        // GBRAIN minder row 3: a query past DEEP_QUERY_ITEMS used to start a 256 MiB-reserved
        // thread for every chunk it matched against. The search now starts one for its walk.
        let store = crate::test_support::store();
        for i in 0..12 {
            put(
                &store,
                &format!("notes/deep-{i}"),
                "note",
                "red apple",
                json!({}),
            );
        }
        let query = "red apple ".repeat(400);
        let all = opts(json!({}));
        super::super::tsearch::reset_deep_spawns();
        assert_eq!(store.count_keyword_pages(&query, &all).unwrap(), 12);
        let spawned = super::super::tsearch::deep_spawns();
        // One for parsing the query and one for the walk over every page.
        assert!(
            spawned <= 2,
            "the search started {spawned} deep-query threads"
        );
        super::super::tsearch::reset_deep_spawns();
        let rows = store
            .search_keyword_pages(&query, &opts(json!({ "phrase": true })))
            .unwrap();
        assert_eq!(rows.len(), 12);
        let spawned = super::super::tsearch::deep_spawns();
        // Two parses (the query and its phrase form) and one walk.
        assert!(
            spawned <= 3,
            "the search started {spawned} deep-query threads"
        );
    }

    #[test]
    fn counts_and_pages_follow_filters_handles_and_keyset() {
        let store = seed();
        let all = opts(json!({}));
        assert_eq!(store.count_keyword_pages("red apple", &all).unwrap(), 3);
        assert_eq!(store.count_keyword_pages("   ", &all).unwrap(), 0);
        let rows = store.search_keyword_pages("red apple", &all).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r["stale"] == false));

        let typed = opts(json!({ "type": "concept" }));
        assert_eq!(
            slugs(&store.search_keyword_pages("red apple", &typed).unwrap()),
            ["notes/three"]
        );

        let active = opts(json!({ "where": [["status", ["active"]]] }));
        let mut got = slugs(&store.search_keyword_pages("red apple", &active).unwrap());
        got.sort();
        assert_eq!(got, ["notes/one", "notes/two"]);
        let cycle = opts(json!({ "where": [["cycle", [2024.0]]], "handles": ["apple-example"] }));
        assert_eq!(
            slugs(&store.search_keyword_pages("apple-example", &cycle).unwrap()),
            ["people/apple-example"]
        );
        let handled = store
            .search_keyword_pages(
                "apple-example",
                &opts(json!({ "handles": ["apple-example"] })),
            )
            .unwrap();
        assert_eq!(handled[0]["slug"], "people/apple-example");
        assert!(handled[0]["score"].as_f64().unwrap() >= 1.0);

        let first = store
            .search_keyword_pages("red apple", &opts(json!({ "limit": 1.0 })))
            .unwrap();
        let after = json!({ "score": first[0]["score"], "pageId": first[0]["page_id"] });
        let rest = store
            .search_keyword_pages("red apple", &opts(json!({ "after": after })))
            .unwrap();
        assert_eq!(rest.len(), 2);
        assert_eq!(slugs(&rows)[1..], slugs(&rest)[..]);
        assert!(
            store
                .search_keyword_pages("red apple", &opts(json!({ "limit": -1.0 })))
                .is_err()
        );
    }

    #[test]
    fn the_phrase_factor_doubles_phrase_matches() {
        let store = seed();
        let plain = store
            .search_keyword_pages("red apple", &opts(json!({})))
            .unwrap();
        let phrased = store
            .search_keyword_pages("red apple", &opts(json!({ "phrase": true })))
            .unwrap();
        let score = |rows: &[Value], slug: &str| {
            rows.iter()
                .find(|r| r["slug"] == slug)
                .and_then(|r| r["score"].as_f64())
                .unwrap()
        };
        assert_eq!(
            score(&phrased, "notes/one"),
            score(&plain, "notes/one") * 2.0
        );
        assert_eq!(score(&phrased, "notes/three"), score(&plain, "notes/three"));
    }

    #[test]
    fn page_search_reports_stale_false_even_with_a_newer_timeline_entry_as_the_sql_engines_do() {
        let store = seed();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let entry = crate::timeline::TimelineInput {
            date: Some("2026-01-02".into()),
            summary: Some("met".into()),
            ..crate::timeline::TimelineInput::default()
        };
        store
            .add_timeline_entry(
                "notes/two",
                &entry,
                &crate::timeline::AddTimelineOptions::default(),
            )
            .unwrap();
        let stale = |rows: &[Value]| {
            rows.iter()
                .map(|r| (r["slug"].as_str().unwrap().to_string(), r["stale"].clone()))
                .collect::<Vec<_>>()
        };
        let text = store
            .search_keyword_pages("red apple", &opts(json!({})))
            .unwrap();
        assert_eq!(
            stale(&text),
            [
                ("notes/two".to_string(), json!(false)),
                ("notes/one".to_string(), json!(false)),
                ("notes/three".to_string(), json!(false)),
            ]
        );
        let handles = store
            .search_keyword_pages(
                "two",
                &opts(json!({ "handles": ["two"], "handlesOnly": true })),
            )
            .unwrap();
        assert_eq!(stale(&handles), [("notes/two".to_string(), json!(false))]);
    }
}
