//! Source-resolution reads: the rows `listLocalPathSources`, `listSourceRoutingRows` and
//! `countDefaultSourceSplit` answer, matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::sources::DefaultSourceSplit;
use gbrain_store::import_members::PageOriginRefresh;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::json;

fn source(store: &Store, id: &str, local_path: Option<&str>, config: serde_json::Value) {
    let input: SourceInput = serde_json::from_value(json!({
        "id": id, "name": id, "local_path": local_path, "config": config,
    }))
    .unwrap();
    store.upsert_source(&input).unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({"sourceId": source_id})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn split(d: u64, n: u64, s: u64) -> DefaultSourceSplit {
    DefaultSourceSplit {
        default_pages: d,
        non_default_pages: n,
        non_default_sources: s,
    }
}

#[test]
fn an_empty_brain_has_no_local_paths_one_routing_row_and_no_pages() {
    let dir = TempDir::new("cli-src-empty");
    let store = open(&dir);
    assert!(store.list_local_path_sources().unwrap().is_empty());
    let rows = store.list_source_routing_rows().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "default");
    assert_eq!(rows[0].local_path, None);
    assert!(!rows[0].archived);
    assert_eq!(
        serde_json::to_value(&rows[0].config).unwrap(),
        json!({"federated": true})
    );
    assert!(!rows[0].default_has_pages);
    assert_eq!(store.count_default_source_split().unwrap(), split(0, 0, 0));
}

#[test]
fn local_path_sources_keep_archived_rows_and_skip_sources_without_a_path() {
    let dir = TempDir::new("cli-src-paths");
    let store = open(&dir);
    source(&store, "beta", Some("/w/beta"), json!({}));
    source(&store, "alpha", Some("/w/alpha"), json!({}));
    source(&store, "nopath", None, json!({}));
    assert!(store.set_source_archived("beta", true).unwrap());
    let rows = serde_json::to_value(store.list_local_path_sources().unwrap()).unwrap();
    assert_eq!(
        rows,
        json!([
            {"id": "alpha", "local_path": "/w/alpha", "archived": false},
            {"id": "beta", "local_path": "/w/beta", "archived": true},
        ])
    );
}

#[test]
fn routing_rows_carry_config_archived_and_whether_default_has_a_live_page() {
    let dir = TempDir::new("cli-src-routing");
    let store = open(&dir);
    source(
        &store,
        "wiki",
        Some("/w/wiki"),
        json!({"role": "storage_manifest"}),
    );
    source(&store, "old", None, json!({}));
    assert!(store.set_source_archived("old", true).unwrap());
    page(&store, "wiki", "notes/a");
    let rows = serde_json::to_value(store.list_source_routing_rows().unwrap()).unwrap();
    assert_eq!(
        rows,
        json!([
            {"id": "default", "local_path": null, "archived": false, "config": {"federated": true}, "default_has_pages": false},
            {"id": "old", "local_path": null, "archived": true, "config": {}, "default_has_pages": false},
            {"id": "wiki", "local_path": "/w/wiki", "archived": false, "config": {"role": "storage_manifest"}, "default_has_pages": false},
        ])
    );
    page(&store, "default", "notes/d");
    assert!(
        store
            .list_source_routing_rows()
            .unwrap()
            .iter()
            .all(|r| r.default_has_pages)
    );
    // A soft-deleted page is not live.
    store.soft_delete_page("notes/d", Some("default")).unwrap();
    assert!(
        store
            .list_source_routing_rows()
            .unwrap()
            .iter()
            .all(|r| !r.default_has_pages)
    );
}

#[test]
fn the_default_split_counts_live_pages_and_distinct_other_sources() {
    let dir = TempDir::new("cli-src-split");
    let store = open(&dir);
    source(&store, "a", None, json!({}));
    source(&store, "b", None, json!({}));
    page(&store, "default", "d1");
    page(&store, "default", "d2");
    page(&store, "a", "x");
    page(&store, "a", "y");
    page(&store, "b", "z");
    assert_eq!(store.count_default_source_split().unwrap(), split(2, 3, 2));
    store.soft_delete_page("z", Some("b")).unwrap();
    store.soft_delete_page("d2", Some("default")).unwrap();
    assert_eq!(store.count_default_source_split().unwrap(), split(1, 2, 1));
    assert_eq!(
        serde_json::to_value(store.count_default_source_split().unwrap()).unwrap(),
        json!({"defaultPages": 1, "nonDefaultPages": 2, "nonDefaultSources": 1})
    );
}

#[test]
fn source_page_counts_keep_to_one_source_and_count_soft_deleted_pages_only_when_asked() {
    let dir = TempDir::new("cli-src-count");
    let store = open(&dir);
    source(&store, "a", None, json!({}));
    source(&store, "ab", None, json!({}));
    page(&store, "a", "x");
    page(&store, "a", "y");
    page(&store, "ab", "z");
    page(&store, "default", "d");
    store.soft_delete_page("y", Some("a")).unwrap();
    assert_eq!(store.count_source_pages("a", false).unwrap(), 1);
    assert_eq!(store.count_source_pages("a", true).unwrap(), 2);
    assert_eq!(store.count_source_pages("ab", false).unwrap(), 1);
    assert_eq!(store.count_source_pages("default", true).unwrap(), 1);
    assert_eq!(store.count_source_pages("missing", true).unwrap(), 0);
}

#[test]
fn insert_source_creates_a_source_and_refuses_a_taken_id_or_name() {
    let dir = TempDir::new("cli-src-insert");
    let store = open(&dir);
    let config = json!({"federated": false, "kind": "url"});
    let row = store
        .insert_source("wiki", "Wiki", Some("/w/wiki"), config.as_object().unwrap())
        .unwrap();
    assert_eq!(row.id, "wiki");
    let got = store.get_source_by_id("wiki").unwrap().unwrap();
    assert_eq!(got.name.as_deref(), Some("Wiki"));
    assert_eq!(got.local_path.as_deref(), Some("/w/wiki"));
    assert_eq!(serde_json::to_value(&got.config).unwrap(), config);
    let empty = serde_json::Map::new();
    let taken_id = store
        .insert_source("wiki", "Other", None, &empty)
        .unwrap_err();
    assert_eq!(taken_id.code, "constraint_violation");
    let taken_name = store
        .insert_source("notes", "Wiki", None, &empty)
        .unwrap_err();
    assert_eq!(taken_name.code, "constraint_violation");
    assert!(store.get_source_by_id("notes").unwrap().is_none());
    let bad = store
        .insert_source("Bad Id", "Bad", None, &empty)
        .unwrap_err();
    assert_eq!(bad.code, "invalid_argument");
    // The first insert is untouched by the refused ones.
    let again = store.get_source_by_id("wiki").unwrap().unwrap();
    assert_eq!(again.name.as_deref(), Some("Wiki"));
}

fn page_at(store: &Store, source_id: &str, slug: &str, path: Option<&str>, fm: serde_json::Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body",
        "source_path": path, "frontmatter": fm,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({"sourceId": source_id})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

#[test]
fn advancing_a_source_commit_stores_it_and_sets_clears_or_keeps_the_newest_time() {
    let dir = TempDir::new("cli-src-advance");
    let store = open(&dir);
    source(&store, "repo", Some("/w/repo"), json!({}));
    store
        .advance_source_commit("repo", "aaaa111", Some(Some("2026-01-02T03:04:05.000Z")))
        .unwrap();
    let plain = store.read_plain_sync_source("repo").unwrap().unwrap();
    assert_eq!(plain.last_commit.as_deref(), Some("aaaa111"));
    let detail = store.get_source("repo").unwrap().unwrap();
    assert_eq!(detail.last_commit.as_deref(), Some("aaaa111"));
    store
        .advance_source_commit("repo", "bbbb222", None)
        .unwrap();
    store
        .advance_source_commit("repo", "cccc333", Some(None))
        .unwrap();
    assert_eq!(
        store
            .read_plain_sync_source("repo")
            .unwrap()
            .unwrap()
            .last_commit
            .as_deref(),
        Some("cccc333")
    );
    store
        .advance_source_commit("missing", "dddd444", None)
        .unwrap();
    assert!(store.get_source("missing").unwrap().is_none());
}

#[test]
fn sync_route_page_reads_keep_to_live_pages_of_one_source() {
    let dir = TempDir::new("cli-src-route");
    let store = open(&dir);
    source(&store, "repo", Some("/w/repo"), json!({}));
    source(&store, "other", Some("/w/other"), json!({}));
    page_at(
        &store,
        "repo",
        "notes/a",
        Some("notes/a.md"),
        json!({"id": "doc-1"}),
    );
    page_at(
        &store,
        "repo",
        "notes/n",
        Some("notes/n.md"),
        json!({"id": 42}),
    );
    page_at(&store, "repo", "notes/none", None, json!({}));
    page_at(
        &store,
        "repo",
        "notes/gone",
        Some("notes/gone.md"),
        json!({"id": "doc-1"}),
    );
    store.soft_delete_page("notes/gone", Some("repo")).unwrap();
    page_at(
        &store,
        "other",
        "notes/a",
        Some("notes/a.md"),
        json!({"id": "doc-1"}),
    );
    let paths: Vec<_> = store
        .list_source_path_pages("repo")
        .unwrap()
        .into_iter()
        .map(|r| (r.slug, r.source_path))
        .collect();
    assert_eq!(
        paths,
        vec![
            ("notes/a".to_string(), "notes/a.md".to_string()),
            ("notes/n".to_string(), "notes/n.md".to_string()),
        ]
    );
    let renamed: Vec<_> = store
        .read_rename_identity_rows(
            "repo",
            &["notes/a.md".to_string(), "notes/gone.md".to_string()],
            &["notes/n".to_string()],
        )
        .unwrap()
        .into_iter()
        .map(|r| r.slug)
        .collect();
    assert_eq!(renamed, vec!["notes/a", "notes/n"]);
    let holders: Vec<_> = store
        .read_live_identity_holders("repo", &["doc-1".to_string(), "42".to_string()], &[])
        .unwrap()
        .into_iter()
        .map(|r| (r.slug, r.fm_id))
        .collect();
    assert_eq!(
        holders,
        vec![
            ("notes/a".to_string(), Some("doc-1".to_string())),
            ("notes/n".to_string(), Some("42".to_string())),
        ]
    );
}

#[test]
fn page_size_rows_keep_to_live_embed_skip_or_over_limit_pages_of_one_source() {
    let dir = TempDir::new("cli-src-size");
    let store = open(&dir);
    source(&store, "repo", Some("/w/repo"), json!({}));
    source(&store, "other", Some("/w/other"), json!({}));
    page_at(
        &store,
        "repo",
        "notes/skip",
        None,
        json!({"embed_skip": true}),
    );
    page_at(&store, "repo", "notes/small", None, json!({}));
    page_at(
        &store,
        "repo",
        "notes/gone",
        None,
        json!({"embed_skip": true}),
    );
    store.soft_delete_page("notes/gone", Some("repo")).unwrap();
    page_at(
        &store,
        "other",
        "notes/other",
        None,
        json!({"embed_skip": true}),
    );
    let rows = store.read_page_size_rows("repo", 64, None).unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, ["notes/skip"]);
    assert_eq!(rows[0].bytes, Some(4));
    assert!(!rows[0].segmented);
    assert!(rows[0].state.is_none() && rows[0].reason.is_none());
    // A limit under the four-byte body brings in every live page of the source.
    let over = store.read_page_size_rows("repo", 3, None).unwrap();
    let slugs: Vec<&str> = over.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, ["notes/skip", "notes/small"]);
    let listed = store
        .read_page_size_rows(
            "repo",
            3,
            Some(&["notes/small".to_string(), "notes/gone".to_string()]),
        )
        .unwrap();
    let slugs: Vec<&str> = listed.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, ["notes/small"]);
    assert!(
        store
            .read_page_size_rows("repo", 3, Some(&[]))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn quarantined_slugs_keep_to_live_pages_of_one_source_with_the_key_set() {
    let dir = TempDir::new("cli-src-quarantine");
    let store = open(&dir);
    source(&store, "repo", Some("/w/repo"), json!({}));
    source(&store, "other", Some("/w/other"), json!({}));
    page_at(
        &store,
        "repo",
        "notes/b",
        None,
        json!({"quarantine": {"reason": "junk_pattern"}}),
    );
    page_at(&store, "repo", "notes/a", None, json!({"quarantine": null}));
    page_at(
        &store,
        "repo",
        "notes/plain",
        None,
        json!({"content_flag": {"reason": "oversized"}}),
    );
    page_at(
        &store,
        "repo",
        "notes/gone",
        None,
        json!({"quarantine": true}),
    );
    store.soft_delete_page("notes/gone", Some("repo")).unwrap();
    page_at(
        &store,
        "other",
        "notes/c",
        None,
        json!({"quarantine": true}),
    );
    assert_eq!(
        store.list_quarantined_slugs("repo").unwrap(),
        vec!["notes/a", "notes/b"]
    );
    assert_eq!(
        store.list_quarantined_slugs("other").unwrap(),
        vec!["notes/c"]
    );
    assert!(store.list_quarantined_slugs("missing").unwrap().is_empty());
    assert!(store.list_quarantined_slugs("re\0po").unwrap().is_empty());
}

#[test]
fn source_page_paths_list_one_sources_live_file_backed_pages_in_slug_byte_order() {
    let dir = TempDir::new("cli-src-paths");
    let store = open(&dir);
    source(&store, "a", None, json!({}));
    source(&store, "ab", None, json!({}));
    for slug in [
        "notes/b",
        "notes/ab",
        "notes/a-c",
        "notes/no-file",
        "notes/gone",
    ] {
        page(&store, "a", slug);
    }
    page(&store, "ab", "notes/z");
    for (source_id, slug) in [
        ("a", "notes/b"),
        ("a", "notes/ab"),
        ("a", "notes/a-c"),
        ("a", "notes/gone"),
        ("ab", "notes/z"),
    ] {
        let refresh = PageOriginRefresh {
            source_id: source_id.into(),
            source_path: format!("{slug}.md"),
            source_uri: None,
        };
        store.refresh_page_origin(slug, &refresh).unwrap();
    }
    store.soft_delete_page("notes/gone", Some("a")).unwrap();
    let paths = |id: &str| -> Vec<(String, String)> {
        store
            .list_source_path_pages(id)
            .unwrap()
            .into_iter()
            .map(|r| (r.slug, r.source_path))
            .collect()
    };
    let pair = |s: &str| (s.to_string(), format!("{s}.md"));
    assert_eq!(
        paths("a"),
        vec![pair("notes/a-c"), pair("notes/ab"), pair("notes/b")]
    );
    assert_eq!(paths("ab"), vec![pair("notes/z")]);
    assert!(paths("missing").is_empty());
}

#[test]
fn identity_reads_match_by_id_and_title_and_read_one_live_page() {
    let dir = TempDir::new("cli-src-rename-identity");
    let store = open(&dir);
    source(&store, "a", None, json!({}));
    source(&store, "b", None, json!({}));
    let put = |source_id: &str, slug: &str, title: &str, frontmatter: serde_json::Value| -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": title, "compiled_truth": "body", "frontmatter": frontmatter,
        }))
        .unwrap();
        let options: PutPageOptions =
            serde_json::from_value(json!({"sourceId": source_id})).unwrap();
        store.put_page(slug, &input, &options).unwrap()["id"]
            .as_u64()
            .unwrap()
    };
    let spec = put("a", "notes/spec", "Spec", json!({"id": "doc-1"}));
    put("a", "notes/num", "Numbered", json!({"id": 7}));
    put("a", "notes/plain", "Spec", json!({}));
    let gone = put("a", "notes/gone", "Gone", json!({"id": "doc-1"}));
    put("b", "notes/spec", "Spec", json!({"id": "doc-1"}));
    let refresh = PageOriginRefresh {
        source_id: "a".into(),
        source_path: "notes/spec.md".into(),
        source_uri: None,
    };
    store.refresh_page_origin("notes/spec", &refresh).unwrap();
    store.soft_delete_page("notes/gone", Some("a")).unwrap();
    let strings = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    let holders = store
        .read_live_identity_holders("a", &strings(&["doc-1", "7"]), &strings(&["Spec"]))
        .unwrap();
    assert_eq!(
        serde_json::to_value(&holders).unwrap(),
        json!([
            {"slug": "notes/num", "source_path": null, "fm_id": "7", "title": "Numbered"},
            {"slug": "notes/plain", "source_path": null, "fm_id": null, "title": "Spec"},
            {"slug": "notes/spec", "source_path": "notes/spec.md", "fm_id": "doc-1", "title": "Spec"},
        ])
    );
    assert!(
        store
            .read_live_identity_holders("missing", &strings(&["doc-1"]), &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        serde_json::to_value(store.read_page_identity(spec).unwrap()).unwrap(),
        json!({"fm_id": "doc-1", "title": "Spec"})
    );
    assert_eq!(store.read_page_identity(gone).unwrap(), None);
    assert_eq!(store.read_page_identity(999_999).unwrap(), None);
}
