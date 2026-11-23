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

use super::filters::{KeywordOptions, PageFilter, result_row, row_count, source_factor};
use super::rank::ts_rank;
use super::tsearch::{TsQuery, phraseto_tsquery, ts_matches, websearch_to_tsquery};
use super::walk::{Admit, ChunkSource, PageOrder, walk_chunks};
use crate::Store;
use crate::error::Result;
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
        let mut extra = vec![&ranker];
        extra.extend(phrase.as_ref());
        let source = ChunkSource::plan(&*read, &[&matcher], &extra, |_| Ok(Some(BTreeSet::new())))?;
        let mut admit = Admit {
            filter: Some(&mut filter),
            text_only: true,
            basenames: None,
        };
        let mut hits: Vec<Hit> = Vec::new();
        walk_chunks(
            &*read,
            &source,
            PageOrder::Any,
            &mut admit,
            &mut |page, chunks| {
                let mut factor: Option<f64> = None;
                let mut best: Option<(f64, crate::chunks::ChunkRecord)> = None;
                for (chunk, vector) in chunks {
                    if !ts_matches(&vector, &matcher) {
                        continue;
                    }
                    let factor =
                        *factor.get_or_insert_with(|| source_factor(&page, &options.boosts));
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
                    return Ok(true);
                };
                let stale = latest_entry_micros(&*read, page.id)?
                    .is_some_and(|latest| page.updated_at_us < latest);
                hits.push(Hit {
                    score,
                    page_id: page.id,
                    chunk_id: chunk.id,
                    row: result_row(&page, &chunk, score, stale),
                });
                Ok(true)
            },
        )?;
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
        let matches: Vec<&TsQuery> = queries.iter().collect();
        let source = ChunkSource::plan(&*read, &matches, &[], |_| Ok(Some(BTreeSet::new())))?;
        let mut admit = Admit {
            filter: None,
            text_only: true,
            basenames: None,
        };
        walk_chunks(
            &*read,
            &source,
            PageOrder::Key,
            &mut admit,
            &mut |page, chunks| {
                for (_, vector) in chunks {
                    for (i, q) in queries.iter().enumerate() {
                        if q.items.is_empty() || counts[i] > cap || !ts_matches(&vector, q) {
                            continue;
                        }
                        counts[i] += 1;
                        pages[i].insert(page.id);
                    }
                }
                Ok(true)
            },
        )?;
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

    fn put_with(store: &Store, slug: &str, page_type: &str, frontmatter: Value) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": page_type, "title": slug, "compiled_truth": "heron heron heron", "timeline": "",
            "frontmatter": frontmatter,
        }))
        .unwrap();
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    /// `excludePrivate` adds the page policy `privatePagesFilterForCaller('p')` before ranking: a hidden page never
    /// takes a result slot (so a limit counts only visible pages), whatever its score.
    #[test]
    fn exclude_private_hides_the_pages_the_page_policy_hides() {
        let store = crate::test_support::store();
        put(&store, "notes/a-open", "heron");
        put_with(
            &store,
            "notes/m-visibility",
            "note",
            json!({ "visibility": "private" }),
        );
        put_with(
            &store,
            "notes/n-access",
            "note",
            json!({ "access": "private" }),
        );
        put_with(
            &store,
            "notes/o-public",
            "note",
            json!({ "visibility": "public", "access": "private" }),
        );
        // A derived page (an atom) is private unless it says otherwise.
        put_with(&store, "notes/p-atom", "atom", json!({}));
        let top = |o: Value| -> Vec<String> {
            slugs(
                &store
                    .search_keyword_arm("heron", "heron", &opts(o))
                    .unwrap(),
            )
        };
        let all = [
            "notes/m-visibility",
            "notes/n-access",
            "notes/o-public",
            "notes/p-atom",
            "notes/a-open",
        ];
        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };
        let mut every = all.map(String::from).to_vec();
        every.sort();
        assert_eq!(sorted(top(json!({ "limit": 5.0 }))), every);
        let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" });
        assert_eq!(
            sorted(top(json!({ "limit": 5.0, "excludePrivate": policy }))),
            ["notes/a-open", "notes/o-public"]
        );
        // The limit counts visible pages only: one visible page fits where the hidden ones would have filled it.
        assert_eq!(
            top(json!({ "limit": 1.0, "excludePrivate": policy })).len(),
            1
        );
        assert_eq!(
            top(json!({ "limit": 1.0, "offset": 1.0, "excludePrivate": policy })).len(),
            1
        );
        // Without the alias keys only `visibility` (and a derived page's default) hides a page.
        let visibility_only =
            json!({ "honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn" });
        assert_eq!(
            sorted(top(json!({ "excludePrivate": visibility_only }))),
            ["notes/a-open", "notes/n-access", "notes/o-public"]
        );
        // With the privacy part relaxed only the member-access part applies: nothing here is hidden.
        let relaxed = json!({ "honorAliases": true, "entityPrivacy": false, "ownerOnly": "fn" });
        assert_eq!(sorted(top(json!({ "excludePrivate": relaxed }))), every);
        // `null` (excludePrivate off) hides nothing, and the policy composes with the other filters.
        assert_eq!(sorted(top(json!({ "excludePrivate": null }))), every);
        assert!(top(json!({ "excludePrivate": policy, "type": "atom" })).is_empty());
        assert_eq!(
            top(json!({ "excludePrivate": policy, "excludeSlugs": ["notes/a-open"] })),
            ["notes/o-public"]
        );
    }

    /// The owner-only part of the page policy: a page of an owner-only source is hidden, and under the `fn` form so is a
    /// concept synthesized from one; under the closed form every page is hidden while the brain holds an owner-only source.
    /// It is part of the member-access test, so a relaxed privacy part does not drop it.
    #[test]
    fn exclude_private_hides_owner_only_pages_and_what_is_derived_from_them() {
        let store = crate::test_support::store();
        let source = |id: &str, config: Value| {
            let input: crate::sources::SourceInput =
                serde_json::from_value(json!({ "id": id, "config": config })).unwrap();
            store.upsert_source(&input).unwrap();
        };
        source("vault", json!({ "owner_only": true }));
        source("chats", json!({ "kind": "imessage" }));
        source("flagged-off", json!({ "owner_only": false }));
        let put_in = |source_id: &str, slug: &str, page_type: &str, frontmatter: Value| {
            let input: crate::pages::PageInput = serde_json::from_value(json!({
                "type": page_type, "title": slug, "compiled_truth": "heron heron", "timeline": "",
                "frontmatter": frontmatter,
            }))
            .unwrap();
            let options = crate::pages::PutPageOptions {
                source_id: Some(source_id.to_string()),
                ..Default::default()
            };
            store.put_page(slug, &input, &options).unwrap();
        };
        put_in("default", "notes/open", "note", json!({}));
        put_in("flagged-off", "notes/flagged-off", "note", json!({}));
        put_in("vault", "notes/vault", "note", json!({}));
        put_in("chats", "notes/chat", "note", json!({}));
        let derived = json!({ "synthesized_by": "dream", "visibility": "world" });
        put_in("default", "concepts/from-vault", "concept", derived.clone());
        put_in("default", "concepts/from-open", "concept", derived);
        let link = |from: &str, to: &str, to_source: &str| {
            let options = crate::links::AddLinkOptions {
                link_type: Some("synthesized_from".into()),
                link_source: Some("concept-provenance".into()),
                to_source_id: Some(to_source.into()),
                ..Default::default()
            };
            store.add_link(from, to, &options).unwrap();
        };
        link("concepts/from-vault", "notes/vault", "vault");
        link("concepts/from-open", "notes/open", "default");
        let top = |form: &str| -> Vec<String> {
            let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": form });
            let mut found = slugs(
                &store
                    .search_keyword_arm(
                        "heron",
                        "heron",
                        &opts(json!({ "limit": 20.0, "excludePrivate": policy })),
                    )
                    .unwrap(),
            );
            found.sort();
            found
        };
        assert_eq!(
            top("fn"),
            ["concepts/from-open", "notes/flagged-off", "notes/open"]
        );
        assert!(top("closed").is_empty());
        // The part belongs to the member-access test: a relaxed privacy part keeps it.
        let relaxed = json!({ "honorAliases": true, "entityPrivacy": false, "ownerOnly": "fn" });
        let mut found = slugs(
            &store
                .search_keyword_arm(
                    "heron",
                    "heron",
                    &opts(json!({ "limit": 20.0, "excludePrivate": relaxed })),
                )
                .unwrap(),
        );
        found.sort();
        assert_eq!(
            found,
            ["concepts/from-open", "notes/flagged-off", "notes/open"]
        );
        // A policy that names no owner-only form takes `closed`, the form that hides the most (owner_only.rs).
        let named =
            opts(json!({ "excludePrivate": { "honorAliases": true, "entityPrivacy": true } }));
        assert_eq!(
            named.exclude_private.as_ref().map(|p| p.owner_only),
            Some(crate::owner_only::OwnerOnlyForm::Closed)
        );
    }

    /// The chunks `put_page` makes itself are raw splits of the body: nothing removed the protected facts / takes fences
    /// from them, so they are not certified by the safe-fence stamp (only a `sealChunks` of sanitized chunks is). A
    /// world-readable note with a secret inside a takes fence, written through the default path, must not come back
    /// from a `requireSafeChunks` search, while the same search without the rule still finds it and a later explicit
    /// seal makes the page safe again.
    #[test]
    fn chunks_made_by_put_page_are_not_safe_until_an_explicit_seal() {
        let store = crate::test_support::store();
        let secret = "<!--- gbrain:takes:begin -->\n| 1 | heron owns the vault, code ZEPHYR-9 | fact | 1 | 2026 |\n<!--- gbrain:takes:end -->";
        put(
            &store,
            "notes/world",
            &format!("heron overview\n\n{secret}"),
        );
        let hits = |o: Value| {
            slugs(
                &store
                    .search_keyword_arm("heron", "heron", &opts(o))
                    .unwrap(),
            )
        };
        assert_eq!(hits(json!({ "limit": 20.0 })), ["notes/world"]);
        assert!(hits(json!({ "limit": 20.0, "requireSafeChunks": true })).is_empty());
        let version = |store: &Store| {
            crate::pages::read_page(
                &*store.read().unwrap(),
                crate::sources::DEFAULT_SOURCE,
                "notes/world",
            )
            .unwrap()
            .unwrap()
            .chunker_version
        };
        assert!(version(&store).is_none_or(|v| v < crate::chunks::SAFE_FENCE_CHUNKER_VERSION));
        // The explicit seal of sanitized chunks certifies the page.
        let clean = crate::chunks::ChunkInput {
            chunk_text: "heron overview".into(),
            ..crate::chunks::ChunkInput::default()
        };
        let seal = crate::chunks::UpsertChunksOptions {
            seal: true,
            ..crate::chunks::UpsertChunksOptions::default()
        };
        store.upsert_chunks("notes/world", &[clean], &seal).unwrap();
        assert_eq!(
            version(&store),
            Some(crate::chunks::SAFE_FENCE_CHUNKER_VERSION)
        );
        assert_eq!(
            hits(json!({ "limit": 20.0, "requireSafeChunks": true })),
            ["notes/world"]
        );
        // A rewrite through the default path takes the safe stamp away again.
        put(&store, "notes/world", &format!("heron changed\n\n{secret}"));
        assert!(version(&store).is_some_and(|v| v < crate::chunks::SAFE_FENCE_CHUNKER_VERSION));
        assert!(hits(json!({ "limit": 20.0, "requireSafeChunks": true })).is_empty());
    }

    /// `requiresSafeChunks` (`chunker_version >= 4`): a page whose recorded chunker version is below the safe fence
    /// chunker, or that records none (the comparison is NULL), is hidden; only a page at the safe version is kept.
    #[test]
    fn require_safe_chunks_keeps_only_a_page_recorded_at_the_safe_chunker() {
        let store = crate::test_support::store();
        put(&store, "notes/none", "heron");
        put(&store, "notes/three", "heron");
        put(&store, "notes/four", "heron");
        store
            .write(|tx| {
                for (slug, version) in [
                    ("notes/none", None),
                    ("notes/three", Some(3)),
                    ("notes/four", Some(4)),
                ] {
                    let mut page =
                        crate::pages::read_page(&*tx, crate::sources::DEFAULT_SOURCE, slug)?
                            .unwrap();
                    page.chunker_version = version;
                    crate::pages::write_page(tx, &page)?;
                }
                Ok(())
            })
            .unwrap();
        let top = |o: Value| -> Vec<String> {
            let mut v = slugs(
                &store
                    .search_keyword_arm("heron", "heron", &opts(o))
                    .unwrap(),
            );
            v.sort();
            v
        };
        assert_eq!(top(json!({})), ["notes/four", "notes/none", "notes/three"]);
        assert_eq!(top(json!({ "requireSafeChunks": true })), ["notes/four"]);
        assert_eq!(
            top(json!({ "requireSafeChunks": false })),
            ["notes/four", "notes/none", "notes/three"]
        );
    }

    /// Distinct tokens whose tsvector is past the 1,048,575-byte cap.
    fn oversized_text() -> String {
        (0..200_000)
            .map(|i| format!("token{i:x}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// A chunk stored with a vector too big for a tsvector (written before `write_chunk` checked it) matches nothing and
    /// fails no search: every member that builds chunk vectors skips it and answers from the other chunks.
    #[test]
    fn a_stored_chunk_that_cannot_be_vectored_is_skipped_by_every_search() {
        let store = crate::test_support::store();
        put(&store, "notes/ok", "heron wades");
        put(&store, "notes/bad", "heron stalks");
        store
            .write(|tx| {
                let page =
                    crate::pages::read_page(&*tx, crate::sources::DEFAULT_SOURCE, "notes/bad")?
                        .unwrap();
                for mut chunk in crate::chunks::read_chunks(&*tx, page.id)? {
                    chunk.chunk_text = format!("heron {}", oversized_text());
                    crate::put_json(tx, &crate::keys::chunk(page.id, chunk.chunk_index), &chunk)?;
                }
                Ok(())
            })
            .unwrap();
        let o = opts(json!({ "limit": 20.0 }));
        assert_eq!(
            slugs(&store.search_keyword_arm("heron", "heron", &o).unwrap()),
            ["notes/ok"]
        );
        assert_eq!(
            slugs(&store.search_keyword_chunks("heron", &o).unwrap()),
            ["notes/ok"]
        );
        assert_eq!(
            slugs(&store.search_keyword_pages("heron", &o).unwrap()),
            ["notes/ok"]
        );
        assert_eq!(store.count_keyword_pages("heron", &o).unwrap(), 1);
        let rare = store
            .keyword_rare_term_pages(&["heron".to_string()], 10.0)
            .unwrap();
        assert_eq!(rare.len(), 1);
    }

    /// `chunk_search_vector_trigger` raises in the write: a chunk that cannot be vectored is refused with the SQL text and
    /// nothing of the batch is stored.
    #[test]
    fn a_chunk_that_cannot_be_vectored_is_refused_at_write() {
        let store = crate::test_support::store();
        put(&store, "notes/ok", "heron wades");
        let before = store.count_chunks().unwrap();
        let big = || crate::chunks::ChunkInput {
            chunk_index: 1,
            chunk_text: oversized_text(),
            ..crate::chunks::ChunkInput::default()
        };
        let err = store
            .upsert_chunks(
                "notes/ok",
                &[
                    crate::chunks::ChunkInput {
                        chunk_text: "heron edited".into(),
                        ..crate::chunks::ChunkInput::default()
                    },
                    big(),
                ],
                &crate::chunks::UpsertChunksOptions::default(),
            )
            .unwrap_err();
        assert!(
            err.message.starts_with("string is too long for tsvector ("),
            "{}",
            err.message
        );
        assert_eq!(store.count_chunks().unwrap(), before);
        let o = opts(json!({ "limit": 20.0 }));
        assert_eq!(
            slugs(&store.search_keyword_arm("heron", "heron", &o).unwrap()),
            ["notes/ok"]
        );
    }
}
