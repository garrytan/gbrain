//! `searchKeywordChunks(query, opts?)`: chunk-grain full-text matches, as PGLite selects them:
//!
//! ```sql
//! SELECT ..., ts_rank(cc.search_vector, websearch_to_tsquery('english', $q)) * <source factor> AS score,
//!        p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id) AS stale
//! FROM content_chunks cc JOIN pages p ON p.id = cc.page_id JOIN sources s ON s.id = p.source_id
//! WHERE cc.search_vector @@ websearch_to_tsquery('english', $q)
//!   <type> <types> <where> <exclude_slugs> <detail low> <language> <symbolKind> <afterDate> <beforeDate>
//!   <sources> <hard excludes> <visibility>
//! ORDER BY score DESC, page_id ASC, chunk_id ASC LIMIT $limit OFFSET $offset
//! ```
//!
//! The TypeScript member passes the collapsed query (`collapseWebsearchDashRuns`), the clamped
//! limit and the resolved filters. Like PGLite there is no `modality = 'text'` predicate, so an
//! image chunk whose text matches is returned. `ts_rank` is a `real`; the product with the
//! factor is a `double precision`, so the score is the f32 rank widened and then multiplied.

use std::collections::BTreeSet;

use super::filters::{KeywordOptions, PageFilter, result_row, row_count, source_factor};
use super::rank::ts_rank;
use super::tsearch::{ts_matches, websearch_to_tsquery};
use super::walk::{Admit, ChunkSource, PageOrder, walk_chunks};
use crate::Store;
use crate::chunks::ChunkRecord;
use crate::error::Result;
use crate::pages::PageRecord;
use crate::timeline::latest_entry_micros;
use serde_json::Value;

/// A matching chunk; its row is built only when it falls in the requested window.
struct Hit {
    score: f64,
    page_id: u64,
    page: usize,
    chunk: ChunkRecord,
    stale: bool,
}

impl Store {
    /// `searchKeywordChunks`: rows in rank order. `options.limit` is the clamped limit (default
    /// 20 when absent); `options.offset` is the rows skipped.
    pub fn search_keyword_chunks(
        &self,
        query: &str,
        options: &KeywordOptions,
    ) -> Result<Vec<Value>> {
        let limit = row_count(options.limit.unwrap_or(20.0), "LIMIT")?;
        let offset = row_count(options.offset.unwrap_or(0.0), "OFFSET")?;
        let q = websearch_to_tsquery(query)?;
        let read = self.read()?;
        let mut filter = PageFilter::new(options)?;
        let source = ChunkSource::plan(&*read, &[&q], &[], |_| Ok(Some(BTreeSet::new())))?;
        let mut admit = Admit {
            filter: Some(&mut filter),
            text_only: false,
            basenames: None,
        };
        let mut hits: Vec<Hit> = Vec::new();
        let mut pages: Vec<PageRecord> = Vec::new();
        walk_chunks(
            &*read,
            &source,
            PageOrder::Any,
            &mut admit,
            &mut |page, chunks| {
                let mut factor: Option<f64> = None;
                let mut stale: Option<bool> = None;
                for (chunk, vector) in chunks {
                    if !ts_matches(&vector, &q) {
                        continue;
                    }
                    let factor =
                        *factor.get_or_insert_with(|| source_factor(&page, &options.boosts));
                    let stale = match stale {
                        Some(s) => s,
                        None => {
                            let s = latest_entry_micros(&*read, page.id)?
                                .is_some_and(|latest| page.updated_at_us < latest);
                            stale = Some(s);
                            s
                        }
                    };
                    hits.push(Hit {
                        score: f64::from(ts_rank(&vector, &q)) * factor,
                        page_id: page.id,
                        page: pages.len(),
                        chunk,
                        stale,
                    });
                }
                if hits.last().is_some_and(|h| h.page == pages.len()) {
                    pages.push(page);
                }
                Ok(true)
            },
        )?;
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(a.page_id.cmp(&b.page_id))
                .then(a.chunk.id.cmp(&b.chunk.id))
        });
        Ok(hits
            .iter()
            .skip(offset)
            .take(limit)
            .map(|h| result_row(&pages[h.page], &h.chunk, h.score, h.stale))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(store: &Store, slug: &str, body: &str, frontmatter: Value) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": body, "timeline": "",
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

    #[test]
    fn matches_rank_boost_and_page_filters() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "quasar quasar quasar", json!({}));
        put(&store, "originals/b", "quasar once", json!({}));
        put(
            &store,
            "notes/hidden",
            "quasar",
            json!({ "quarantine": true }),
        );
        put(&store, "notes/none", "nothing here", json!({}));

        let rows = store
            .search_keyword_chunks("quasar", &opts(json!({})))
            .unwrap();
        assert_eq!(slugs(&rows), ["notes/a", "originals/b"]);
        let plain = rows[1]["score"].as_f64().unwrap();
        assert!(plain > 0.0);

        let boosted = store
            .search_keyword_chunks(
                "quasar",
                &opts(json!({ "boosts": [["originals/", 100.0]] })),
            )
            .unwrap();
        assert_eq!(slugs(&boosted), ["originals/b", "notes/a"]);
        assert_eq!(boosted[0]["score"].as_f64().unwrap(), plain * 100.0);

        let excluded = store
            .search_keyword_chunks("quasar", &opts(json!({ "hardExcludes": ["notes/"] })))
            .unwrap();
        assert_eq!(slugs(&excluded), ["originals/b"]);

        let windowed = store
            .search_keyword_chunks("quasar", &opts(json!({ "limit": 1.0, "offset": 1.0 })))
            .unwrap();
        assert_eq!(slugs(&windowed), ["originals/b"]);
        assert!(
            store
                .search_keyword_chunks("", &opts(json!({})))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn date_bounds_compare_the_effective_or_update_time() {
        let store = crate::test_support::store();
        put(&store, "notes/dated", "quasar", json!({}));
        let rows = store
            .search_keyword_chunks("quasar", &opts(json!({})))
            .unwrap();
        assert_eq!(rows.len(), 1);
        let future = (i64::MAX / 2).to_string();
        let none = store
            .search_keyword_chunks(
                "quasar",
                &opts(json!({ "afterDate": { "micros": future, "inclusive": true } })),
            )
            .unwrap();
        assert!(none.is_empty());
        let all = store
            .search_keyword_chunks(
                "quasar",
                &opts(json!({ "beforeDate": { "micros": future } })),
            )
            .unwrap();
        assert_eq!(all.len(), 1);
        assert!(
            store
                .search_keyword_chunks("quasar", &opts(json!({ "offset": 1.5 })))
                .is_err()
        );
    }
}
