//! Chunk reads beyond the core chunks family (chunk_queries). Expected rows follow the PGLite SQL
//! in src/core/engine-sql/chunks.ts (getChunkPage, getChunkWindows, chunklessPagesWhere).

mod common;

use common::TempDir;
use gbrain_store::chunk_queries::{
    ChunkPageOptions, ChunkWindowOptions, ChunkWindowRequest, ChunklessOptions,
};
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};
use std::sync::Arc;

struct Brain {
    _dir: TempDir,
    store: Store,
}

impl Brain {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
        let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        Brain { _dir: dir, store }
    }

    fn source(&self, id: &str) {
        let input: SourceInput = serde_json::from_value(json!({"id": id, "name": id})).unwrap();
        self.store.upsert_source(&input).unwrap();
    }

    /// Writes the page alone (no chunks, nothing sealed), as the TypeScript `putPage` does.
    fn page(&self, slug: &str, source: &str, extra: Value) -> u64 {
        let mut body =
            json!({"type": "note", "title": slug, "compiled_truth": format!("{slug} body")});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let input: PageInput = serde_json::from_value(body).unwrap();
        let options: PutPageOptions =
            serde_json::from_value(json!({"sourceId": source, "index": false})).unwrap();
        self.store.put_page(slug, &input, &options).unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    /// `sealChunks`: replaces the page's chunks and seals them.
    fn seal(&self, slug: &str, source: &str, chunks: &[(u32, &str, &str)]) {
        let inputs: Vec<ChunkInput> = chunks
            .iter()
            .map(|(index, text, chunk_source)| {
                serde_json::from_value(json!({
                    "chunk_index": index, "chunk_text": text, "chunk_source": chunk_source,
                }))
                .unwrap()
            })
            .collect();
        let options = UpsertChunksOptions {
            source_id: Some(source.into()),
            seal: true,
            ..UpsertChunksOptions::default()
        };
        self.store.upsert_chunks(slug, &inputs, &options).unwrap();
    }
}

fn texts(page: &Value) -> Vec<String> {
    page["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["chunk_text"].as_str().unwrap().to_string())
        .collect()
}

fn page_opts(source: &str, from: f64, limit: f64) -> ChunkPageOptions {
    ChunkPageOptions {
        source_id: source.into(),
        source_ids: Vec::new(),
        from_index: from,
        limit,
        exclude_private: None,
        require_safe_chunks: false,
    }
}

#[test]
fn chunk_page_reads_an_index_range_with_totals() {
    let b = Brain::new("chunk-page");
    b.page("notes/paged", "default", json!({}));
    let chunks: Vec<(u32, String)> = ["a", "b", "c", "d", "e"]
        .iter()
        .enumerate()
        .map(|(i, t)| (i as u32, format!("chunk {t}")))
        .collect();
    let refs: Vec<(u32, &str, &str)> = chunks
        .iter()
        .map(|(i, t)| (*i, t.as_str(), "compiled_truth"))
        .collect();
    b.seal("notes/paged", "default", &refs);

    let first = b
        .store
        .get_chunk_page("notes/paged", &page_opts("default", 0.0, 2.0))
        .unwrap();
    assert_eq!(texts(&first), ["chunk a", "chunk b"]);
    assert_eq!(first["total_chunks"], 5);
    assert_eq!(first["max_chunk_index"], 4);
    let tail = b
        .store
        .get_chunk_page("notes/paged", &page_opts("default", 4.0, 10.0))
        .unwrap();
    assert_eq!(texts(&tail), ["chunk e"]);
    let past = b
        .store
        .get_chunk_page("notes/paged", &page_opts("default", 50.0, 10.0))
        .unwrap();
    assert!(texts(&past).is_empty());
    assert_eq!(past["total_chunks"], 5);

    // An absent page, a page in another source and an unsealed page read as no chunks.
    let none = json!({"chunks": [], "total_chunks": 0, "max_chunk_index": null});
    for (slug, source) in [("notes/nobody", "default"), ("notes/paged", "other")] {
        assert_eq!(
            b.store
                .get_chunk_page(slug, &page_opts(source, 0.0, 10.0))
                .unwrap(),
            none
        );
    }
    // A body write moves the revision: the old chunks are no longer sealed.
    b.page(
        "notes/paged",
        "default",
        json!({"compiled_truth": "new body"}),
    );
    assert_eq!(
        b.store
            .get_chunk_page("notes/paged", &page_opts("default", 0.0, 10.0))
            .unwrap(),
        none
    );
}

/// A read over several sources merges the pages in document order and breaks a tie by source id in byte order
/// (`co-op` before `cob`), as `ORDER BY chunkDocumentOrder, p.source_id COLLATE "C"` does; the count is the sum.
#[test]
fn chunk_reads_over_several_sources_break_a_tie_by_source_id_bytes() {
    let b = Brain::new("chunk-page-sources");
    for id in ["cob", "co-op"] {
        b.source(id);
    }
    b.page("notes/tie", "cob", json!({}));
    b.seal(
        "notes/tie",
        "cob",
        &[
            (0, "cob 0", "compiled_truth"),
            (1, "cob 1", "compiled_truth"),
            (2, "cob 2", "compiled_truth"),
        ],
    );
    b.page("notes/tie", "co-op", json!({}));
    b.seal(
        "notes/tie",
        "co-op",
        &[
            (0, "co-op 0", "compiled_truth"),
            (1, "co-op 1", "compiled_truth"),
        ],
    );
    let several = |from: f64, limit: f64| ChunkPageOptions {
        source_ids: vec!["cob".into(), "co-op".into(), "cob".into()],
        ..page_opts("default", from, limit)
    };
    let page = b
        .store
        .get_chunk_page("notes/tie", &several(1.0, 5.0))
        .unwrap();
    assert_eq!(texts(&page), ["co-op 1", "cob 1", "cob 2"]);
    assert_eq!(
        (
            page["total_chunks"].clone(),
            page["max_chunk_index"].clone()
        ),
        (json!(5), json!(2))
    );
    let options: gbrain_store::chunks::GetChunksOptions =
        serde_json::from_value(json!({"sourceIds": ["cob", "co-op"]})).unwrap();
    let all: Vec<String> = b
        .store
        .get_chunks_with("notes/tie", &options)
        .unwrap()
        .iter()
        .map(|c| c["chunk_text"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(all, ["co-op 0", "cob 0", "co-op 1", "cob 1", "cob 2"]);
}

fn req(page_id: u64, from: i64, to: i64, priority: i64) -> ChunkWindowRequest {
    ChunkWindowRequest {
        page_id: page_id as i64,
        from_index: from,
        to_index: to,
        priority,
    }
}

fn win_opts(sources: &[&str], max_rows: u64) -> ChunkWindowOptions {
    ChunkWindowOptions {
        chunk_sources: sources.iter().map(|s| s.to_string()).collect(),
        max_rows,
        ..ChunkWindowOptions::default()
    }
}

fn kinds(rows: &[Value], kind: &str) -> Vec<Value> {
    rows.iter().filter(|r| r["kind"] == kind).cloned().collect()
}

#[test]
fn chunk_windows_authorize_pages_and_cap_rows() {
    let b = Brain::new("chunk-windows");
    b.source("archived");
    let alpha = b.page("notes/alpha", "default", json!({}));
    b.seal(
        "notes/alpha",
        "default",
        &[
            (0, "alpha 0", "compiled_truth"),
            (1, "alpha 1", "compiled_truth"),
            (2, "alpha 2", "compiled_truth"),
            (3, "alpha 3", "compiled_truth"),
        ],
    );
    let beta = b.page("notes/beta", "default", json!({}));
    b.seal(
        "notes/beta",
        "default",
        &[(0, "beta 0", "compiled_truth"), (1, "- beta", "timeline")],
    );
    let gone = b.page("notes/gone", "default", json!({}));
    b.seal("notes/gone", "default", &[(0, "gone 0", "compiled_truth")]);
    b.store.soft_delete_page("notes/gone", None).unwrap();
    let junk = b.page(
        "notes/junk",
        "default",
        json!({"frontmatter": {"quarantine": {"reason": "test"}}}),
    );
    b.seal("notes/junk", "default", &[(0, "junk 0", "compiled_truth")]);
    let unsealed = b.page("notes/unsealed", "default", json!({}));
    let shelved = b.page("notes/shelved", "archived", json!({}));
    b.seal(
        "notes/shelved",
        "archived",
        &[(0, "shelved 0", "compiled_truth")],
    );
    b.store.set_source_archived("archived", true).unwrap();

    let requests = [
        req(alpha, 1, 2, 3),
        req(alpha, 0, 0, 0),
        req(beta, 0, 5, 1),
        req(gone, 0, 5, 2),
        req(junk, 0, 5, 2),
        req(unsealed, 0, 5, 2),
        req(shelved, 0, 5, 2),
        req(999_999, 0, 5, 2),
    ];
    let rows = b
        .store
        .get_chunk_windows(&requests, &win_opts(&["compiled_truth", "timeline"], 50))
        .unwrap();
    let pages = kinds(&rows, "page");
    assert_eq!(pages.len(), 2);
    let alpha_row = pages.iter().find(|p| p["page_id"] == alpha).unwrap();
    // The lowest priority asked for a page is its priority; max_chunk_index counts every chunk.
    assert_eq!(alpha_row["prio"], 0);
    assert_eq!(alpha_row["max_chunk_index"], 3);
    assert_eq!(alpha_row["sealed"], true);
    assert_eq!(alpha_row["slug"], "notes/alpha");
    let chunk_ids: Vec<(u64, u64)> = kinds(&rows, "chunk")
        .iter()
        .map(|c| {
            (
                c["page_id"].as_u64().unwrap(),
                c["chunk_index"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        chunk_ids,
        [(alpha, 0), (alpha, 1), (alpha, 2), (beta, 0), (beta, 1)]
    );

    // A chunk source filter drops the timeline chunk; maxRows keeps maxRows + 1 chunk rows.
    let low = b
        .store
        .get_chunk_windows(&requests, &win_opts(&["compiled_truth"], 50))
        .unwrap();
    assert_eq!(kinds(&low, "chunk").len(), 4);
    let capped = b
        .store
        .get_chunk_windows(&requests, &win_opts(&["compiled_truth", "timeline"], 2))
        .unwrap();
    assert_eq!(kinds(&capped, "chunk").len(), 3);
    assert_eq!(kinds(&capped, "page").len(), 2);

    // A scope keeps pages of its sources only.
    let scoped = ChunkWindowOptions {
        source_id: Some("other".into()),
        ..win_opts(&["compiled_truth"], 50)
    };
    assert!(
        b.store
            .get_chunk_windows(&requests, &scoped)
            .unwrap()
            .is_empty()
    );
    assert!(
        b.store
            .get_chunk_windows(&[], &win_opts(&["compiled_truth"], 50))
            .unwrap()
            .is_empty()
    );
}

fn chunkless(source: Option<&str>, batch: Option<u64>, after: Option<i64>) -> ChunklessOptions {
    ChunklessOptions {
        source_id: source.map(str::to_string),
        batch_size: batch,
        after_page_id: after,
    }
}

#[test]
fn chunkless_pages_have_a_body_and_no_chunks() {
    let b = Brain::new("chunkless");
    let never = b.page("notes/never", "default", json!({}));
    let timeline = b.page(
        "notes/timeline",
        "default",
        json!({"compiled_truth": "", "timeline": "- 2026-02-02: only"}),
    );
    let skipped = b.page(
        "notes/skipped",
        "default",
        json!({"frontmatter": {"embed_skip": {"reason": "oversize"}}}),
    );
    b.page("notes/empty", "default", json!({"compiled_truth": ""}));
    b.page("notes/chunked", "default", json!({}));
    b.seal(
        "notes/chunked",
        "default",
        &[(0, "chunked", "compiled_truth")],
    );
    // Sealed with no chunks: nothing to heal.
    b.page("notes/sealed-empty", "default", json!({}));
    b.seal("notes/sealed-empty", "default", &[]);
    b.page("notes/deleted", "default", json!({}));
    b.store.soft_delete_page("notes/deleted", None).unwrap();
    b.page(
        "notes/junk",
        "default",
        json!({"frontmatter": {"quarantine": true}}),
    );

    assert_eq!(
        b.store
            .count_chunkless_pages_with_content(&chunkless(None, None, None))
            .unwrap(),
        3
    );
    let rows = b
        .store
        .list_chunkless_pages_with_content(&chunkless(None, None, None))
        .unwrap();
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, [never, timeline, skipped]);
    assert_eq!(
        rows[1],
        json!({"id": timeline, "slug": "notes/timeline", "source_id": "default",
               "compiled_truth": "", "timeline": "- 2026-02-02: only"})
    );
    let page = b
        .store
        .list_chunkless_pages_with_content(&chunkless(None, Some(1), Some(never as i64)))
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["id"], timeline);
    assert_eq!(
        b.store
            .count_chunkless_pages_with_content(&chunkless(Some("no-such"), None, None))
            .unwrap(),
        0
    );
    // An empty source id scopes nothing.
    assert_eq!(
        b.store
            .count_chunkless_pages_with_content(&chunkless(Some(""), None, None))
            .unwrap(),
        3
    );
}

#[test]
fn chunk_reads_hide_private_pages_and_pages_short_of_the_safe_fence() {
    let b = Brain::new("chunk-private");
    let pages = [
        ("notes/open", json!({})),
        (
            "notes/private",
            json!({"frontmatter": {"visibility": "private"}}),
        ),
        (
            "notes/readers",
            json!({"frontmatter": {"readable_by": ["alice-example"]}}),
        ),
        (
            "notes/alias",
            json!({"frontmatter": {"access": "restricted"}}),
        ),
        ("notes/unsafe", json!({})),
    ];
    let mut ids = Vec::new();
    for (slug, extra) in &pages {
        ids.push(b.page(slug, "default", extra.clone()));
        b.seal(slug, "default", &[(0, "a chunk", "compiled_truth")]);
    }
    // Sealed text, but a chunker version short of the safe fence.
    b.store
        .set_chunker_version("notes/unsafe", "3", Some("default"))
        .unwrap();
    let honored = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    let visibility_only = PrivacyPolicy {
        honor_aliases: false,
        entity_privacy: true,
        ..Default::default()
    };
    let page_seen = |policy: Option<PrivacyPolicy>, safe: bool| -> Vec<&str> {
        pages
            .iter()
            .map(|(slug, _)| *slug)
            .filter(|slug| {
                let options = ChunkPageOptions {
                    exclude_private: policy.clone(),
                    require_safe_chunks: safe,
                    ..page_opts("default", 0.0, 10.0)
                };
                b.store.get_chunk_page(slug, &options).unwrap()["total_chunks"] == 1
            })
            .collect()
    };
    assert_eq!(page_seen(None, false).len(), 5);
    assert_eq!(page_seen(Some(honored.clone()), true), ["notes/open"]);
    assert_eq!(
        page_seen(Some(honored.clone()), false),
        ["notes/open", "notes/unsafe"]
    );
    assert_eq!(
        page_seen(Some(visibility_only.clone()), true),
        ["notes/open", "notes/alias"]
    );
    assert_eq!(page_seen(None, true).len(), 4);

    let requests: Vec<ChunkWindowRequest> = ids.iter().map(|&id| req(id, 0, 5, 0)).collect();
    let window_seen = |policy: Option<PrivacyPolicy>, safe: bool| -> Vec<u64> {
        let options = ChunkWindowOptions {
            exclude_private: policy,
            require_safe_chunks: safe,
            ..win_opts(&["compiled_truth"], 50)
        };
        let rows = b.store.get_chunk_windows(&requests, &options).unwrap();
        let mut seen: Vec<u64> = kinds(&rows, "page")
            .iter()
            .map(|r| r["page_id"].as_u64().unwrap())
            .collect();
        seen.sort_unstable();
        seen
    };
    assert_eq!(window_seen(None, false).len(), 5);
    assert_eq!(window_seen(Some(honored.clone()), true), [ids[0]]);
    assert_eq!(window_seen(Some(honored.clone()), false), [ids[0], ids[4]]);
    assert_eq!(
        window_seen(Some(visibility_only.clone()), true),
        [ids[0], ids[3]]
    );
    assert_eq!(window_seen(None, true).len(), 4);
}
