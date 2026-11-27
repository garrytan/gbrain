//! Chunks and keyword search: what `upsertChunks`, `getChunks` and `searchKeyword` do.

mod common;

use common::{TempDir, open};
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::*;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::search::SearchOptions;
use gbrain_store::{Store, sources::SourceInput};
use serde_json::{Value, json};

fn input(title: &str, body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": title, "compiled_truth": body})).unwrap()
}

fn typed(kind: &str, title: &str, body: &str) -> PageInput {
    serde_json::from_value(json!({"type": kind, "title": title, "compiled_truth": body})).unwrap()
}

fn opts(v: Value) -> PutPageOptions {
    serde_json::from_value(v).unwrap()
}

fn search_opts(v: Value) -> SearchOptions {
    serde_json::from_value(v).unwrap()
}

fn put(store: &Store, slug: &str, body: &str) -> Value {
    store
        .put_page(slug, &input(slug, body), &PutPageOptions::default())
        .unwrap()
}

fn find(store: &Store, query: &str) -> Vec<Value> {
    store
        .search_keyword(query, &SearchOptions::default())
        .unwrap()
}

fn slugs(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| r["slug"].as_str().unwrap().to_string())
        .collect()
}

fn chunks(v: Value) -> Vec<ChunkInput> {
    serde_json::from_value(v).unwrap()
}

#[test]
fn an_empty_brain_finds_nothing_and_so_does_an_empty_query() {
    let dir = TempDir::new("search-empty");
    let store = open(&dir);
    assert!(find(&store, "anything").is_empty());
    put(&store, "notes/a", "alpha beta");
    assert!(find(&store, "").is_empty());
    assert!(find(&store, "!!! ---").is_empty());
    assert!(find(&store, "zzzz").is_empty());
}

#[test]
fn put_page_chunks_the_body_and_search_finds_it() {
    let dir = TempDir::new("search-basic");
    let store = open(&dir);
    let page = put(
        &store,
        "people/ada",
        "Ada Lovelace wrote the first program for the Analytical Engine.",
    );
    assert_eq!(
        page["text_projection_revision"], page["knowledge_revision"],
        "sealed on put"
    );
    let rows = find(&store, "analytical engine");
    assert_eq!(slugs(&rows), ["people/ada"]);
    let row = &rows[0];
    assert_eq!(row["title"], "people/ada");
    assert_eq!(row["type"], "note");
    assert_eq!(row["chunk_source"], "compiled_truth");
    assert_eq!(row["chunk_index"], 0);
    assert_eq!(row["stale"], false);
    assert_eq!(row["page_id"], page["id"]);
    assert!(row["score"].as_f64().unwrap() > 0.0);
    assert!(
        row["chunk_text"]
            .as_str()
            .unwrap()
            .contains("Analytical Engine")
    );
    // case does not matter, and punctuation is not part of a word
    assert_eq!(slugs(&find(&store, "LOVELACE,")), ["people/ada"]);
}

#[test]
fn every_term_must_match() {
    let dir = TempDir::new("search-and");
    let store = open(&dir);
    put(&store, "a", "red green blue");
    put(&store, "b", "red green");
    put(&store, "c", "red");
    assert_eq!(slugs(&find(&store, "red green blue")), ["a"]);
    let mut both = slugs(&find(&store, "red green"));
    both.sort();
    assert_eq!(both, ["a", "b"]);
    assert_eq!(find(&store, "red purple").len(), 0);
    // a stop word in the query is dropped; a query of only stop words is kept
    assert_eq!(slugs(&find(&store, "the blue")), ["a"]);
    assert!(find(&store, "the").is_empty());
}

#[test]
fn a_better_match_ranks_first_and_ties_break_by_page() {
    let dir = TempDir::new("search-rank");
    let store = open(&dir);
    put(
        &store,
        "mention",
        "one filler word then rust and many more filler words follow here to dilute it",
    );
    put(&store, "focused", "rust rust rust");
    let rows = find(&store, "rust");
    assert_eq!(slugs(&rows), ["focused", "mention"]);
    assert!(rows[0]["score"].as_f64().unwrap() > rows[1]["score"].as_f64().unwrap());
    put(&store, "twin-1", "identical text");
    put(&store, "twin-2", "identical text");
    let rows = find(&store, "identical");
    assert_eq!(
        slugs(&rows),
        ["twin-1", "twin-2"],
        "equal scores order by page id"
    );
    assert_eq!(rows[0]["score"], rows[1]["score"]);
}

#[test]
fn a_page_is_one_result_and_its_best_chunk_is_returned() {
    let dir = TempDir::new("search-best-chunk");
    let store = open(&dir);
    put(&store, "doc", "placeholder");
    store
        .upsert_chunks(
            "doc",
            &chunks(json!([
                {"chunk_index": 0, "chunk_text": "needle in a very long stretch of unrelated words that makes this chunk weak for ranking purposes", "chunk_source": "compiled_truth"},
                {"chunk_index": 1, "chunk_text": "needle needle", "chunk_source": "timeline"},
            ])),
            &UpsertChunksOptions::default(),
        )
        .unwrap();
    // upsertChunks without an expected revision does not seal; seal through put_page
    store
        .put_page(
            "doc",
            &input("doc", "placeholder"),
            &opts(json!({"chunks": [
                {"chunk_index": 0, "chunk_text": "needle in a very long stretch of unrelated words that makes this chunk weak for ranking purposes", "chunk_source": "compiled_truth"},
                {"chunk_index": 1, "chunk_text": "needle needle", "chunk_source": "timeline"},
            ]})),
        )
        .unwrap();
    let rows = find(&store, "needle");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["chunk_index"], 1);
    assert_eq!(rows[0]["chunk_source"], "timeline");
    // detailLow keeps compiled_truth chunks only
    let low = store
        .search_keyword("needle", &search_opts(json!({"detailLow": true})))
        .unwrap();
    assert_eq!(low[0]["chunk_index"], 0);
    assert_eq!(low[0]["chunk_source"], "compiled_truth");
}

#[test]
fn an_update_replaces_the_chunks_and_the_old_words_stop_matching() {
    let dir = TempDir::new("search-update");
    let store = open(&dir);
    put(&store, "doc", "original wording about apples");
    assert_eq!(slugs(&find(&store, "apples")), ["doc"]);
    store
        .put_page(
            "doc",
            &input("doc", "new wording about oranges"),
            &PutPageOptions::default(),
        )
        .unwrap();
    assert!(find(&store, "apples").is_empty());
    assert_eq!(slugs(&find(&store, "oranges")), ["doc"]);
    assert_eq!(store.count_chunks().unwrap(), 1);
    let kept = store.get_chunks("doc", &ReadScope::default()).unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["chunk_text"], "new wording about oranges");
}

#[test]
fn an_unchanged_put_keeps_its_chunks_and_their_ids() {
    let dir = TempDir::new("search-unchanged");
    let store = open(&dir);
    put(&store, "doc", "stable body");
    let before = store.get_chunks("doc", &ReadScope::default()).unwrap();
    put(&store, "doc", "stable body");
    let after = store.get_chunks("doc", &ReadScope::default()).unwrap();
    assert_eq!(before, after);
}

#[test]
fn deleted_pages_do_not_appear_and_a_restored_page_needs_its_chunks_again() {
    let dir = TempDir::new("search-delete");
    let store = open(&dir);
    put(&store, "keep", "shared words");
    put(&store, "gone", "shared words");
    store.soft_delete_page("gone", None).unwrap();
    assert_eq!(slugs(&find(&store, "shared")), ["keep"]);
    store.restore_page("gone", None).unwrap();
    // restore changes the knowledge revision, so the old chunks are not served until re-sealed
    assert_eq!(slugs(&find(&store, "shared")), ["keep"]);
    put(&store, "gone", "shared words");
    assert_eq!(slugs(&find(&store, "shared")), ["keep", "gone"]);
    store.delete_page("gone", None).unwrap();
    assert_eq!(slugs(&find(&store, "shared")), ["keep"]);
    assert_eq!(
        store.count_chunks().unwrap(),
        1,
        "hard delete removes chunks"
    );
    assert!(
        store
            .get_chunks("gone", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_tag_change_hides_the_page_until_it_is_chunked_again() {
    let dir = TempDir::new("search-tags");
    let store = open(&dir);
    put(&store, "doc", "taggable words");
    store.add_tag("doc", "x", None).unwrap();
    assert!(find(&store, "taggable").is_empty());
    put(&store, "doc", "taggable words");
    assert_eq!(slugs(&find(&store, "taggable")), ["doc"]);
}

#[test]
fn sources_scope_search_and_archived_sources_are_hidden() {
    let dir = TempDir::new("search-sources");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            ..Default::default()
        })
        .unwrap();
    put(&store, "d", "common phrase");
    store
        .put_page(
            "w",
            &input("w", "common phrase"),
            &opts(json!({"sourceId": "work"})),
        )
        .unwrap();
    let all = find(&store, "common");
    assert_eq!(all.len(), 2);
    let only_work = store
        .search_keyword("common", &search_opts(json!({"sources": ["work"]})))
        .unwrap();
    assert_eq!(slugs(&only_work), ["w"]);
    assert_eq!(only_work[0]["source_id"], "work");
    let default = store
        .search_keyword("common", &search_opts(json!({"sources": ["default"]})))
        .unwrap();
    assert_eq!(slugs(&default), ["d"]);
    store.set_source_archived("work", true).unwrap();
    assert_eq!(slugs(&find(&store, "common")), ["d"]);
    store.set_source_archived("work", false).unwrap();
    assert_eq!(find(&store, "common").len(), 2);
}

/// The caller names the hidden slug prefixes (`hardExcludes`; the TypeScript member passes
/// `test/`, `attachments/` and `.raw/` unless asked otherwise) and exact slugs to leave out.
#[test]
fn hard_excludes_and_excluded_slugs_hide_pages() {
    let dir = TempDir::new("search-excludes");
    let store = open(&dir);
    for slug in ["test/fixture", "attachments/pdf", ".raw/blob", "notes/real"] {
        put(&store, slug, "needle");
    }
    let mut every = slugs(&find(&store, "needle"));
    every.sort();
    assert_eq!(
        every,
        [".raw/blob", "attachments/pdf", "notes/real", "test/fixture"]
    );
    let hidden = store
        .search_keyword(
            "needle",
            &search_opts(json!({"hardExcludes": ["test/", "attachments/", ".raw/"]})),
        )
        .unwrap();
    assert_eq!(slugs(&hidden), ["notes/real"]);
    let back = store
        .search_keyword(
            "needle",
            &search_opts(json!({"hardExcludes": ["attachments/", ".raw/"]})),
        )
        .unwrap();
    let mut back = slugs(&back);
    back.sort();
    assert_eq!(back, ["notes/real", "test/fixture"]);
    let exact = store
        .search_keyword(
            "needle",
            &search_opts(json!({
                "hardExcludes": ["attachments/", ".raw/"],
                "excludeSlugs": ["notes/real"],
            })),
        )
        .unwrap();
    assert_eq!(slugs(&exact), ["test/fixture"]);
}

#[test]
fn type_filters_limit_and_offset() {
    let dir = TempDir::new("search-filters");
    let store = open(&dir);
    for (slug, kind) in [
        ("p1", "person"),
        ("p2", "person"),
        ("c1", "company"),
        ("n1", "note"),
    ] {
        store
            .put_page(
                slug,
                &typed(kind, slug, "filterword"),
                &PutPageOptions::default(),
            )
            .unwrap();
    }
    let run = |v: Value| slugs(&store.search_keyword("filterword", &search_opts(v)).unwrap());
    assert_eq!(run(json!({"type": "company"})), ["c1"]);
    assert_eq!(
        run(json!({"types": ["person", "company"]})),
        ["p1", "p2", "c1"]
    );
    assert_eq!(run(json!({"limit": 2})), ["p1", "p2"]);
    assert_eq!(run(json!({"limit": 2, "offset": 2})), ["c1", "n1"]);
    assert_eq!(run(json!({"offset": 10})), Vec::<String>::new());
}

/// The keyword arm honours a frontmatter `where` filter.
#[test]
fn a_where_filter_keeps_only_pages_whose_frontmatter_holds() {
    let dir = TempDir::new("search-where");
    let store = open(&dir);
    let done: PageInput = serde_json::from_value(json!({
        "type": "note", "title": "done", "compiled_truth": "needle", "frontmatter": {"status": "done"},
    }))
    .unwrap();
    store
        .put_page("notes/done", &done, &PutPageOptions::default())
        .unwrap();
    put(&store, "notes/plain", "needle");
    let run = |v: Value| slugs(&store.search_keyword("needle", &search_opts(v)).unwrap());
    assert_eq!(
        run(json!({"where": [["status", ["done"]]]})),
        ["notes/done"]
    );
    assert!(run(json!({"where": [["status", ["open"]]]})).is_empty());
}

#[test]
fn image_chunks_are_not_searched() {
    let dir = TempDir::new("search-image");
    let store = open(&dir);
    put(&store, "doc", "base");
    store
        .put_page(
            "doc",
            &input("doc", "base"),
            &opts(json!({"chunks": [
                {"chunk_index": 0, "chunk_text": "visible words", "chunk_source": "compiled_truth"},
                {"chunk_index": 1, "chunk_text": "ocr words", "chunk_source": "image_asset", "modality": "image"},
            ]})),
        )
        .unwrap();
    assert_eq!(slugs(&find(&store, "visible")), ["doc"]);
    assert!(find(&store, "ocr").is_empty());
}

#[test]
fn long_bodies_are_split_and_a_cjk_query_is_left_to_the_cjk_fallback() {
    let dir = TempDir::new("search-long");
    let store = open(&dir);
    let paragraph = |w: &str| format!("{} ", w).repeat(200);
    let body = format!(
        "{}\n\n{}\n\n{}",
        paragraph("alpha"),
        paragraph("beta"),
        paragraph("gamma")
    );
    put(&store, "long", &body);
    let kept = store.get_chunks("long", &ReadScope::default()).unwrap();
    assert!(kept.len() >= 3, "{} chunks", kept.len());
    for (i, c) in kept.iter().enumerate() {
        assert_eq!(c["chunk_index"], i);
        assert!(c["chunk_text"].as_str().unwrap().chars().count() <= 1500);
    }
    assert_eq!(find(&store, "gamma").len(), 1);
    assert!(
        find(&store, "alpha gamma").is_empty(),
        "no single chunk holds both"
    );
    // A CJK query is the TypeScript member's CJK fallback (`searchKeywordCjk`); the keyword arm,
    // like PGLite's strict statement, reads the CJK run as one word.
    put(&store, "cjk", "東京は日本の首都です");
    assert!(find(&store, "首都").is_empty());
}

#[test]
fn a_page_put_without_indexing_has_no_chunks_and_reads_them_only_once_sealed() {
    let dir = TempDir::new("search-unindexed");
    let store = open(&dir);
    let page = store
        .put_page(
            "doc",
            &input("doc", "heliotrope body"),
            &opts(json!({"index": false})),
        )
        .unwrap();
    assert_eq!(page["text_projection_revision"], Value::Null);
    assert_eq!(store.count_chunks().unwrap(), 0, "put_page wrote no chunks");
    assert!(find(&store, "heliotrope").is_empty());
    let revision = page["knowledge_revision"].as_str().unwrap().to_string();
    // Chunks written with no revision are stored but not read: the page is not sealed.
    store
        .upsert_chunks(
            "doc",
            &chunks(json!([{"chunk_index": 0, "chunk_text": "heliotrope body", "model": "voyage:voyage-4"}])),
            &UpsertChunksOptions::default(),
        )
        .unwrap();
    assert_eq!(store.count_chunks().unwrap(), 1);
    assert!(
        store
            .get_chunks("doc", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
    assert!(find(&store, "heliotrope").is_empty());
    // Sealing to the revision makes them current, with the model the caller stamped.
    store
        .upsert_chunks(
            "doc",
            &chunks(json!([{"chunk_index": 0, "chunk_text": "heliotrope body", "model": "voyage:voyage-4"}])),
            &UpsertChunksOptions {
                expected_revision: Some(revision),
                seal: true,
                ..Default::default()
            },
        )
        .unwrap();
    let got = store.get_chunks("doc", &ReadScope::default()).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["model"], "voyage:voyage-4");
    assert_eq!(slugs(&find(&store, "heliotrope")), ["doc"]);
    // A tag change moves the revision: the chunks stay stored and stop being read.
    store.add_tag("doc", "late", None).unwrap();
    assert!(
        store
            .get_chunks("doc", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.count_chunks().unwrap(), 1);
    // An unchanged put with indexing off does not seal what a tag change unsealed.
    store
        .put_page(
            "doc",
            &input("doc", "heliotrope body"),
            &opts(json!({"index": false})),
        )
        .unwrap();
    assert!(
        store
            .get_chunks("doc", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn upsert_chunks_checks_the_revision_and_seals_to_it() {
    let dir = TempDir::new("search-upsert");
    let store = open(&dir);
    let page = put(&store, "doc", "base");
    let revision = page["knowledge_revision"].as_str().unwrap().to_string();
    let err = store
        .upsert_chunks("missing", &[], &UpsertChunksOptions::default())
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
    let stale = UpsertChunksOptions {
        expected_revision: Some("00000000-0000-4000-8000-000000000000".into()),
        ..Default::default()
    };
    assert_eq!(
        store.upsert_chunks("doc", &[], &stale).unwrap_err().code,
        REVISION_CONFLICT
    );
    let bad = UpsertChunksOptions {
        expected_revision: Some("nope".into()),
        ..Default::default()
    };
    assert_eq!(
        store.upsert_chunks("doc", &[], &bad).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let good = UpsertChunksOptions {
        expected_revision: Some(revision.clone()),
        seal: true,
        ..Default::default()
    };
    store
        .upsert_chunks("doc", &chunks(json!([{"chunk_index": 0, "chunk_text": "custom words", "token_count": 2, "language": "rust"}])), &good)
        .unwrap();
    assert_eq!(slugs(&find(&store, "custom")), ["doc"]);
    let got = store.get_chunks("doc", &ReadScope::default()).unwrap();
    assert_eq!(got[0]["token_count"], 2);
    assert_eq!(got[0]["language"], "rust");
    assert_eq!(got[0]["embedding"], Value::Null);
    let rust = store
        .search_keyword("custom", &search_opts(json!({"language": "rust"})))
        .unwrap();
    assert_eq!(rust.len(), 1);
    let other = store
        .search_keyword("custom", &search_opts(json!({"language": "go"})))
        .unwrap();
    assert!(other.is_empty());
    let bad_source =
        chunks(json!([{"chunk_index": 0, "chunk_text": "x", "chunk_source": "nonsense"}]));
    assert_eq!(
        store
            .upsert_chunks("doc", &bad_source, &good)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    // the failed call changed nothing
    assert_eq!(slugs(&find(&store, "custom")), ["doc"]);
    store.delete_chunks("doc", None).unwrap();
    assert!(find(&store, "custom").is_empty());
    assert_eq!(store.count_chunks().unwrap(), 0);
}

#[test]
fn chunks_and_search_survive_a_reopen() {
    let dir = TempDir::new("search-reopen");
    {
        let store = open(&dir);
        put(&store, "people/ada", "durable keyword evidence");
        put(&store, "people/bob", "other words");
        store.close();
    }
    let store = open(&dir);
    assert_eq!(slugs(&find(&store, "durable evidence")), ["people/ada"]);
    assert_eq!(store.count_chunks().unwrap(), 2);
    put(&store, "people/cy", "durable again");
    assert_eq!(slugs(&find(&store, "durable")).len(), 2);
}

#[test]
fn quarantined_and_pinned_question_pages_are_hidden_whatever_the_key_holds() {
    let dir = TempDir::new("search-quarantine");
    let store = open(&dir);
    put(&store, "notes/visible", "glimmerwort marker");
    let hidden = |slug: &str, frontmatter: Value| {
        let page: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "glimmerwort marker", "frontmatter": frontmatter
        }))
        .unwrap();
        store
            .put_page(slug, &page, &PutPageOptions::default())
            .unwrap();
    };
    hidden(
        "notes/quarantined",
        json!({"quarantine": {"reason": "junk"}}),
    );
    hidden("notes/quarantined-null", json!({"quarantine": null}));
    hidden("notes/pinned", json!({"pinned_question": true}));
    // content_flag warns but does not hide
    hidden(
        "notes/flagged",
        json!({"content_flag": {"reason": "oversized"}}),
    );
    assert_eq!(
        slugs(&find(&store, "glimmerwort")),
        ["notes/visible", "notes/flagged"]
    );
    // no slug prefix setting unhides a quarantined page
    let opted = store
        .search_keyword(
            "glimmerwort",
            &search_opts(json!({"hardExcludes": ["test/"]})),
        )
        .unwrap();
    assert_eq!(slugs(&opted), ["notes/visible", "notes/flagged"]);
    // the page is still stored and readable
    assert!(
        store
            .read_page_snapshot("notes/quarantined", &ReadScope::default())
            .unwrap()
            .is_some()
    );
}

#[test]
fn an_incremental_write_keeps_metadata_for_unchanged_text_and_never_seals() {
    let dir = TempDir::new("search-incremental");
    let store = open(&dir);
    let page = store
        .put_page("doc", &input("doc", "body"), &opts(json!({"index": false})))
        .unwrap();
    let revision = page["knowledge_revision"].as_str().unwrap().to_string();
    let sealed = UpsertChunksOptions {
        expected_revision: Some(revision.clone()),
        seal: true,
        ..Default::default()
    };
    store
        .upsert_chunks(
            "doc",
            &chunks(json!([
                {"chunk_index": 0, "chunk_text": "alpha", "language": "ts", "symbol_name": "f", "model": "m:1"},
                {"chunk_index": 1, "chunk_text": "beta"},
                {"chunk_index": 2, "chunk_text": "gamma"}
            ])),
            &sealed,
        )
        .unwrap();
    // A write that repeats chunk 0 with no metadata keeps it; chunk 1 changed so takes the new
    // (empty) metadata; chunk 2 is gone. `expectedRevision` alone checks and does not seal.
    store
        .upsert_chunks(
            "doc",
            &chunks(json!([
                {"chunk_index": 0, "chunk_text": "alpha", "model": "m:2"},
                {"chunk_index": 1, "chunk_text": "beta changed"}
            ])),
            &UpsertChunksOptions {
                expected_revision: Some(revision),
                ..Default::default()
            },
        )
        .unwrap();
    let got = store.get_chunks("doc", &ReadScope::default()).unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!(got[0]["language"], "ts");
    assert_eq!(got[0]["symbol_name"], "f");
    assert_eq!(got[0]["model"], "m:2", "the model is the new write's");
    assert_eq!(got[1]["chunk_text"], "beta changed");
    assert!(got[1].get("language").is_none());
    // An empty write removes every chunk and unseals the page.
    store
        .upsert_chunks("doc", &[], &UpsertChunksOptions::default())
        .unwrap();
    assert_eq!(store.count_chunks().unwrap(), 0);
    let page = store
        .read_page_snapshot("doc", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(page["page"]["text_projection_revision"], Value::Null);
}

#[test]
fn delete_chunks_clears_the_seal_so_a_later_unsealed_write_stays_unread() {
    let dir = TempDir::new("search-delete-seal");
    let store = open(&dir);
    let page = put(&store, "doc", "base");
    let revision = page["knowledge_revision"].as_str().unwrap().to_string();
    let seal = UpsertChunksOptions {
        expected_revision: Some(revision),
        seal: true,
        ..Default::default()
    };
    store
        .upsert_chunks(
            "doc",
            &chunks(json!([{"chunk_index": 0, "chunk_text": "sealed words"}])),
            &seal,
        )
        .unwrap();
    assert_eq!(slugs(&find(&store, "sealed")), ["doc"]);
    store.delete_chunks("doc", None).unwrap();
    // PGLite's deleteChunks voids the seal: an ordinary upsert after it is not certified by it.
    store
        .upsert_chunks(
            "doc",
            &chunks(json!([{"chunk_index": 0, "chunk_text": "unsealed marigold"}])),
            &UpsertChunksOptions::default(),
        )
        .unwrap();
    assert!(
        store
            .get_chunks("doc", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
    assert!(find(&store, "marigold").is_empty());
    assert_eq!(store.count_chunks().unwrap(), 1);
}

#[test]
fn seal_chunks_on_a_page_in_an_archived_source_is_page_not_found_and_writes_nothing() {
    let dir = TempDir::new("search-archived-seal");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            ..Default::default()
        })
        .unwrap();
    let page = store
        .put_page(
            "w",
            &input("w", "kept body"),
            &opts(json!({"sourceId": "work"})),
        )
        .unwrap();
    let revision = page["knowledge_revision"].as_str().unwrap().to_string();
    let before = store.count_chunks().unwrap();
    store.set_source_archived("work", true).unwrap();
    let err = store
        .upsert_chunks(
            "w",
            &chunks(json!([{"chunk_index": 0, "chunk_text": "replacement"}])),
            &UpsertChunksOptions {
                source_id: Some("work".into()),
                expected_revision: Some(revision),
                seal: true,
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
    assert_eq!(err.message, "Page not found: w (source=work)");
    assert_eq!(store.count_chunks().unwrap(), before);
    store.set_source_archived("work", false).unwrap();
    let got = store
        .get_chunks(
            "w",
            &ReadScope {
                source_id: Some("work".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(got.iter().all(|c| c["chunk_text"] != "replacement"));
}
