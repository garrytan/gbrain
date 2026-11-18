//! `searchKeyword(query, opts?)`: the keyword arm, one row per page, as PGLite's statement
//! selects it:
//!
//! ```sql
//! WITH ranked AS (
//!   SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY page_id ORDER BY score DESC, chunk_id ASC) AS page_rank
//!     FROM (SELECT ..., ts_rank(cc.search_vector, websearch_to_tsquery('english', $rank))
//!                         * <phrase factor of $rank> * <source factor> AS score, <stale>
//!           FROM content_chunks cc JOIN pages p ON p.id = cc.page_id JOIN sources s ON s.id = p.source_id
//!           WHERE cc.search_vector @@ websearch_to_tsquery('english', $match) <filters> <visibility>
//!             AND cc.modality = 'text') matched) per_page WHERE page_rank = 1
//!   ORDER BY score DESC, page_id ASC, chunk_id ASC LIMIT $inner),
//! best_per_page AS (SELECT DISTINCT ON (COALESCE(source_id, 'default'), slug) * FROM ranked ...)
//! SELECT * FROM best_per_page ORDER BY score DESC, page_id ASC, chunk_id ASC LIMIT $limit OFFSET $offset
//! ```
//!
//! `(source_id, slug)` is unique, so `best_per_page` keeps every row; the window applies to the
//! first `$inner` pages, so an offset past them returns fewer rows, as on PGLite. The TypeScript
//! member runs the strict statement and the retries of `search/keyword-identifier-probe.ts`
//! (identifier probe, any-word retry, handle pages) and `search/keyword-or-rarity.ts` through
//! this one statement with other match and rank queries, and reads the rare words' pages through
//! [`Store::keyword_rare_term_pages`].
//!
//! `ts_rank` is a `real`; times the integer phrase factor it stays a `real` (exact: the factor is 1
//! or 2), and times the numeric source factor it is a `double precision`.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::filters::{
    KeywordOptions, PageFilter, chunk_vector, result_row, row_count, served, source_factor,
};
use super::rank::ts_rank;
use super::tsearch::{phraseto_tsquery, ts_matches, websearch_to_tsquery};
use crate::Store;
use crate::chunks::{read_chunks, read_segment_view};
use crate::error::Result;
use crate::pages::all_pages;
use crate::timeline::latest_entry_micros;

/// `KEYWORD_PHRASE_FACTOR` (search/sql-ranking.ts).
const KEYWORD_PHRASE_FACTOR: f64 = 2.0;

struct Hit {
    score: f64,
    page_id: u64,
    chunk_id: u64,
    row: Value,
}

impl Store {
    /// The keyword arm's statement: pages whose text chunks match `match_query`, each with its
    /// best chunk by `rank_query`, in score order. `options.limit` is the clamped limit (default
    /// 20), `options.inner_limit` the candidates kept first (default 3x the limit),
    /// `options.offset` the rows skipped.
    pub fn search_keyword_arm(
        &self,
        match_query: &str,
        rank_query: &str,
        options: &KeywordOptions,
    ) -> Result<Vec<Value>> {
        let limit = row_count(options.limit.unwrap_or(20.0), "LIMIT")?;
        let inner = match options.inner_limit {
            Some(n) => row_count(n, "LIMIT")?,
            None => limit.saturating_mul(3),
        };
        let offset = row_count(options.offset.unwrap_or(0.0), "OFFSET")?;
        let matcher = websearch_to_tsquery(match_query)?;
        let ranker = websearch_to_tsquery(rank_query)?;
        let phrase = if options.phrase {
            Some(phraseto_tsquery(rank_query)?)
        } else {
            None
        };
        let read = self.read()?;
        let mut filter = PageFilter::new(options)?;
        let mut hits: Vec<Hit> = Vec::new();
        for page in all_pages(&*read)? {
            if !filter.keeps(&*read, &page)? {
                continue;
            }
            let generation = read_segment_view(&*read, page.id)?.generation;
            let mut factor: Option<f64> = None;
            let mut best: Option<(f64, crate::chunks::ChunkRecord)> = None;
            for chunk in read_chunks(&*read, page.id)? {
                if !chunk.visible_at(generation)
                    || chunk.modality != "text"
                    || !filter.keeps_chunk(&chunk)
                {
                    continue;
                }
                let vector = chunk_vector(&chunk)?;
                if !ts_matches(&vector, &matcher) {
                    continue;
                }
                let factor = *factor.get_or_insert_with(|| source_factor(&page, &options.boosts));
                let phrase = match &phrase {
                    Some(p) if ts_matches(&vector, p) => KEYWORD_PHRASE_FACTOR,
                    _ => 1.0,
                };
                let score = f64::from(ts_rank(&vector, &ranker)) * phrase * factor;
                let better = best
                    .as_ref()
                    .is_none_or(|(s, b)| score > *s || (score == *s && chunk.id < b.id));
                if better {
                    best = Some((score, chunk));
                }
            }
            let Some((score, chunk)) = best else {
                continue;
            };
            let stale = latest_entry_micros(&*read, page.id)?
                .is_some_and(|latest| page.updated_at_us < latest);
            hits.push(Hit {
                score,
                page_id: page.id,
                chunk_id: chunk.id,
                row: result_row(&page, &chunk, score, stale),
            });
        }
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(a.page_id.cmp(&b.page_id))
                .then(a.chunk_id.cmp(&b.chunk_id))
        });
        Ok(hits
            .into_iter()
            .take(inner)
            .skip(offset)
            .take(limit)
            .map(|h| h.row)
            .collect())
    }

    /// `rareTermPagesSql` (search/keyword-or-rarity.ts): per word, in order, the text chunks that
    /// match it (counted up to `cap + 1`) and their distinct pages, ascending. Like the SQL, it
    /// reads every page whose served text projection holds the chunk, with no source scope, and
    /// a word whose query has no lexemes (a stopword) matches nothing.
    pub fn keyword_rare_term_pages(&self, terms: &[String], cap: f64) -> Result<Vec<Value>> {
        let cap = row_count(cap, "LIMIT")?;
        let queries = terms
            .iter()
            .map(|t| websearch_to_tsquery(t))
            .collect::<Result<Vec<_>>>()?;
        let mut counts = vec![0usize; terms.len()];
        let mut pages: Vec<BTreeSet<u64>> = vec![BTreeSet::new(); terms.len()];
        let read = self.read()?;
        for page in all_pages(&*read)? {
            if !served(&page) {
                continue;
            }
            let generation = read_segment_view(&*read, page.id)?.generation;
            for chunk in read_chunks(&*read, page.id)? {
                if !chunk.visible_at(generation) || chunk.modality != "text" {
                    continue;
                }
                let vector = chunk_vector(&chunk)?;
                for (i, q) in queries.iter().enumerate() {
                    if q.items.is_empty() || counts[i] > cap || !ts_matches(&vector, q) {
                        continue;
                    }
                    counts[i] += 1;
                    pages[i].insert(page.id);
                }
            }
        }
        Ok(terms
            .iter()
            .zip(counts)
            .zip(pages)
            .map(|((term, chunks), ids)| {
                json!({ "term": term, "chunks": chunks, "page_ids": ids.into_iter().collect::<Vec<_>>() })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(store: &Store, slug: &str, body: &str) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": body, "timeline": "",
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

    #[test]
    fn one_row_per_page_ranked_by_the_rank_query_and_windowed_inside_the_candidates() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "quasar quasar quasar nebula");
        put(&store, "notes/b", "quasar once");
        put(&store, "notes/c", "nebula nebula only");
        let rows = store
            .search_keyword_arm("quasar", "quasar", &opts(json!({})))
            .unwrap();
        assert_eq!(slugs(&rows), ["notes/a", "notes/b"]);
        // Matched by one query, ranked by another: `nebula` ranks notes/c first.
        let any = store
            .search_keyword_arm("quasar or nebula", "nebula", &opts(json!({})))
            .unwrap();
        assert_eq!(any.len(), 3);
        assert_eq!(slugs(&any)[0], "notes/c");
        // The offset applies inside the first `inner` candidates.
        let cut = store
            .search_keyword_arm(
                "quasar or nebula",
                "quasar or nebula",
                &opts(json!({ "limit": 2.0, "innerLimit": 2.0, "offset": 1.0 })),
            )
            .unwrap();
        assert_eq!(cut.len(), 1);
    }

    #[test]
    fn rare_term_pages_count_chunks_and_skip_stopwords() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "quokka");
        put(&store, "notes/b", "quokka acme");
        put(&store, "notes/c", "acme");
        let rows = store
            .keyword_rare_term_pages(
                &["quokka".to_string(), "the".to_string(), "acme".to_string()],
                400.0,
            )
            .unwrap();
        assert_eq!(rows[0]["chunks"], 2);
        assert_eq!(rows[1]["chunks"], 0);
        assert_eq!(rows[1]["page_ids"], json!([]));
        assert_eq!(rows[2]["chunks"], 2);
        // The count stops one past the cap.
        let capped = store
            .keyword_rare_term_pages(&["quokka".to_string()], 0.0)
            .unwrap();
        assert_eq!(capped[0]["chunks"], 1);
    }
}
