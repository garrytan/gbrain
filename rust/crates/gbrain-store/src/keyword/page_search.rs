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
//! collapse), and `stale` is always false. With `handlesOnly` only the handle arm runs
//! (`searchHandlePages`, the keyword arm's rows for the pages a slug handle names).

use std::collections::BTreeMap;

use super::filters::{
    KeywordOptions, PageFilter, readable_chunk_vector, result_row, row_count, source_factor,
};
use super::rank::ts_rank;
use super::tsearch::{
    TsQuery, phraseto_tsquery, ts_matches, websearch_to_tsquery, with_query_stack,
};
use crate::Store;
use crate::chunks::{ChunkRecord, read_chunks, read_segment_view};
use crate::error::{Result, StoreError};
use crate::pages::{PageRecord, all_pages};
use serde_json::Value;

/// `KEYWORD_COUNT_CAP` (search/keyword-statement.ts).
const KEYWORD_COUNT_CAP: usize = 10_000;

/// `KEYWORD_PHRASE_FACTOR` (search/sql-ranking.ts).
const KEYWORD_PHRASE_FACTOR: f64 = 2.0;

/// A page's best matching chunk.
struct Best {
    score: f64,
    chunk: ChunkRecord,
}

struct Matcher {
    query: TsQuery,
    phrase: Option<TsQuery>,
}

impl Store {
    /// Visits every page that matches with its best chunk; `visit` returns false to stop.
    fn keyword_pages(
        &self,
        query: &str,
        options: &KeywordOptions,
        mut visit: impl FnMut(PageRecord, Best) -> bool + Send,
    ) -> Result<()> {
        if query.trim().is_empty() {
            return Ok(());
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
            for page in all_pages(&*read)? {
                if !filter.keeps(&*read, &page)? {
                    continue;
                }
                let basename = page.slug.rsplit('/').next().unwrap_or(&page.slug);
                let handle = options.handles.iter().any(|h| h == basename);
                if options.handles_only && !handle {
                    continue;
                }
                let generation = read_segment_view(&*read, page.id)?.generation;
                let mut factor: Option<f64> = None;
                let mut best: Option<Best> = None;
                for chunk in read_chunks(&*read, page.id)? {
                    if !chunk.visible_at(generation)
                        || chunk.modality != "text"
                        || !filter.keeps_chunk(&chunk)
                    {
                        continue;
                    }
                    let Some(vector) = readable_chunk_vector(&chunk) else {
                        continue;
                    };
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
                        best = Some(Best { score, chunk });
                    }
                }
                if let Some(best) = best
                    && !visit(page, best)
                {
                    break;
                }
            }
            Ok(())
        })
    }

    /// `countKeywordPages`: the matching pages, at most `KEYWORD_COUNT_CAP + 1`.
    pub fn count_keyword_pages(&self, query: &str, options: &KeywordOptions) -> Result<u64> {
        let mut n = 0usize;
        self.keyword_pages(query, options, |_, _| {
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
        self.keyword_pages(query, options, |page, best| {
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
            .map(|(page, best)| result_row(&page, &best.chunk, best.score, false))
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
}
