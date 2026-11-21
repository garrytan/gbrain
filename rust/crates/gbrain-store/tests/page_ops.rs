//! Page operations: batch snapshots, duplicates, batch deletes, the purge, find and count, the
//! samplers, frontmatter marker reads, date reads and `revertToVersion`, matched to PGLite.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::sources::SourceInput;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put_in(store: &Store, source: &str, slug: &str, page: Value) -> Value {
    store
        .put_page(
            slug,
            &de::<PageInput>(page),
            &de::<PutPageOptions>(json!({ "sourceId": source })),
        )
        .unwrap()
}

fn put(store: &Store, slug: &str, page: Value) -> Value {
    put_in(store, "default", slug, page)
}

fn note(title: &str, body: &str) -> Value {
    json!({ "type": "note", "title": title, "compiled_truth": body })
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            ..Default::default()
        })
        .unwrap();
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

fn slugs_of(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| r["slug"].as_str().unwrap().to_string())
        .collect()
}

fn id_of(page: &Value) -> i64 {
    page["id"].as_i64().unwrap()
}

#[test]
fn get_all_slugs_includes_soft_deleted_pages_and_scopes_by_source() {
    let dir = TempDir::new("ops-all-slugs");
    let store = open(&dir);
    source(&store, "work");
    put(&store, "notes/b", note("B", "b"));
    put(&store, "notes/a", note("A", "a"));
    put_in(&store, "work", "notes/a", note("A", "a"));
    put_in(&store, "work", "notes/w", note("W", "w"));
    store.soft_delete_page("notes/b", Some("default")).unwrap();
    let all = store.get_all_slugs(&de(json!({}))).unwrap();
    assert_eq!(all, vec!["notes/a", "notes/b", "notes/w"]);
    let work = store
        .get_all_slugs(&de(json!({ "sourceId": "work" })))
        .unwrap();
    assert_eq!(work, vec!["notes/a", "notes/w"]);
    let empty_id = store.get_all_slugs(&de(json!({ "sourceId": "" }))).unwrap();
    assert_eq!(empty_id, all);
    let none = store
        .get_all_slugs(&de(json!({ "sourceId": "no-such" })))
        .unwrap();
    assert!(none.is_empty());
}

#[test]
fn list_all_page_refs_lists_live_pages_by_source_then_slug() {
    let dir = TempDir::new("ops-refs");
    let store = open(&dir);
    source(&store, "work");
    put(&store, "notes/b", note("B", "b"));
    put(&store, "notes/a", note("A", "a"));
    put(&store, "notes/gone", note("G", "g"));
    put_in(&store, "work", "notes/a", note("A", "a"));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    let refs = store.list_all_page_refs().unwrap();
    let keys: Vec<String> = refs
        .iter()
        .map(|r| {
            format!(
                "{}:{}",
                r["source_id"].as_str().unwrap(),
                r["slug"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        keys,
        vec!["default:notes/a", "default:notes/b", "work:notes/a"]
    );
    assert!(refs[0]["updated_at"].as_str().unwrap().ends_with('Z'));
}

#[test]
fn snapshot_batch_answers_each_ref_and_stops_at_the_byte_budget() {
    let dir = TempDir::new("ops-batch");
    let store = open(&dir);
    put(&store, "notes/a", note("A", "aaaaaaaaaa"));
    put(&store, "notes/b", note("B", "bbbbbbbbbb"));
    put(&store, "notes/c", note("C", "c"));
    let refs = de::<Vec<gbrain_store::page_ops::PageRef>>(json!([
        { "slug": "notes/a", "sourceId": "default" },
        { "slug": "notes/missing", "sourceId": "default" },
        { "slug": "notes/b", "sourceId": "default" },
        { "slug": "notes/c", "sourceId": "default" },
    ]));
    let all = store
        .read_page_snapshots_batch(&refs, &de(json!({})))
        .unwrap();
    assert_eq!(all["covered"], 4);
    assert_eq!(all["snapshots"][0]["page"]["slug"], "notes/a");
    assert!(all["snapshots"][1].is_null());
    let single = store
        .read_page_snapshot(
            "notes/a",
            &de::<ReadScope>(json!({ "sourceId": "default" })),
        )
        .unwrap()
        .unwrap();
    assert_eq!(all["snapshots"][0]["revision"], single["revision"]);
    // 10 bytes before ref 3 (index 2) fits a budget of 15; 20 bytes before ref 4 does not.
    let budget = store
        .read_page_snapshots_batch(&refs, &de(json!({ "maxBytes": 15 })))
        .unwrap();
    assert_eq!(budget["covered"], 3);
    // The first ref is always covered.
    let tiny = store
        .read_page_snapshots_batch(&refs, &de(json!({ "maxBytes": 0 })))
        .unwrap();
    assert_eq!(tiny["covered"], 1);
    store.soft_delete_page("notes/a", Some("default")).unwrap();
    let live = store
        .read_page_snapshots_batch(&refs[..1], &de(json!({})))
        .unwrap();
    assert!(live["snapshots"][0].is_null());
    let deleted = store
        .read_page_snapshots_batch(&refs[..1], &de(json!({ "includeDeleted": true })))
        .unwrap();
    assert_eq!(deleted["snapshots"][0]["page"]["slug"], "notes/a");
}

#[test]
fn find_duplicate_page_prefers_a_frontmatter_id_match_then_the_lowest_id() {
    let dir = TempDir::new("ops-dup");
    let store = open(&dir);
    let a = put(
        &store,
        "notes/a",
        json!({ "type": "note", "title": "A", "compiled_truth": "same", "frontmatter": { "id": "x-1" } }),
    );
    let b = put(&store, "notes/b", note("A", "same"));
    let hash = a["content_hash"].as_str().unwrap().to_string();
    let by_hash = store
        .find_duplicate_page("default", &de(json!({ "hash": hash })))
        .unwrap()
        .unwrap();
    assert_eq!(by_hash["slug"], "notes/a");
    let excluded = store
        .find_duplicate_page(
            "default",
            &de(json!({ "hash": hash, "excludeSlug": "notes/a" })),
        )
        .unwrap();
    let expected_b = if b["content_hash"] == a["content_hash"] {
        Some("notes/b")
    } else {
        None
    };
    assert_eq!(
        excluded.as_ref().map(|v| v["slug"].as_str().unwrap()),
        expected_b
    );
    let by_id = store
        .find_duplicate_page(
            "default",
            &de(json!({ "hash": "nope", "frontmatterId": "x-1" })),
        )
        .unwrap()
        .unwrap();
    assert_eq!(by_id["slug"], "notes/a");
    assert_eq!(by_id["id"].as_i64().unwrap(), id_of(&a));
    let other_source = store
        .find_duplicate_page("work", &de(json!({ "hash": hash })))
        .unwrap();
    assert!(other_source.is_none());
    let many = store
        .find_duplicate_pages(
            "default",
            &de::<Vec<_>>(json!([{ "hash": hash }, { "hash": "nope" }, { "hash": "nope", "frontmatterId": "x-1", "excludeSlug": "notes/a" }])),
        )
        .unwrap();
    let view: Vec<Option<String>> = many
        .iter()
        .map(|m| m.as_ref().map(|v| v["slug"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(view, vec![Some("notes/a".into()), None, None]);
    store.soft_delete_page("notes/a", Some("default")).unwrap();
    let after = store
        .find_duplicate_page(
            "default",
            &de(json!({ "hash": "nope", "frontmatterId": "x-1" })),
        )
        .unwrap();
    assert!(after.is_none(), "a soft-deleted page is never a duplicate");
}

#[test]
fn soft_delete_pages_reports_only_real_transitions() {
    let dir = TempDir::new("ops-soft");
    let store = open(&dir);
    let before = put(&store, "notes/a", note("A", "a"));
    put(&store, "notes/b", note("B", "b"));
    let src = de(json!({ "sourceId": "default" }));
    let slugs = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let hidden = store
        .soft_delete_pages(
            &slugs(&["notes/b", "notes/a", "notes/a", "notes/missing"]),
            &src,
        )
        .unwrap();
    assert_eq!(
        hidden,
        vec!["notes/a", "notes/b"],
        "page id order, once each"
    );
    assert!(
        store
            .soft_delete_pages(&slugs(&["notes/a"]), &src)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .soft_delete_pages(&slugs(&["notes/b"]), &de(json!({})))
            .unwrap()
            .is_empty()
    );
    let snap = store
        .read_page_snapshot(
            "notes/a",
            &de::<ReadScope>(json!({ "sourceId": "default", "includeDeleted": true })),
        )
        .unwrap()
        .unwrap();
    assert!(snap["page"]["deleted_at"].is_string());
    assert_eq!(
        snap["page"]["updated_at"], before["updated_at"],
        "updated_at stays"
    );
}

#[test]
fn delete_pages_removes_live_and_deleted_pages_of_the_source() {
    let dir = TempDir::new("ops-delete");
    let store = open(&dir);
    source(&store, "work");
    put(&store, "notes/a", note("A", "a"));
    put(&store, "notes/b", note("B", "b"));
    put_in(&store, "work", "notes/a", note("A", "a"));
    store.soft_delete_page("notes/b", Some("default")).unwrap();
    let gone = store
        .delete_pages(
            &[
                "notes/b".to_string(),
                "notes/a".to_string(),
                "notes/missing".to_string(),
            ],
            &de(json!({ "sourceId": "default" })),
        )
        .unwrap();
    assert_eq!(gone, vec!["notes/a", "notes/b"]);
    assert_eq!(
        store.get_all_slugs(&de(json!({}))).unwrap(),
        vec!["notes/a"]
    );
    assert_eq!(
        store
            .get_all_slugs(&de(json!({ "sourceId": "default" })))
            .unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn purge_deleted_pages_respects_the_cutoff_and_excluded_ids() {
    let dir = TempDir::new("ops-purge");
    let store = open(&dir);
    put(&store, "notes/a", note("A", "a"));
    let b = put(&store, "notes/b", note("B", "b"));
    put(&store, "notes/c", note("C", "c"));
    store.soft_delete_page("notes/a", Some("default")).unwrap();
    store.soft_delete_page("notes/b", Some("default")).unwrap();
    let not_yet = store.purge_deleted_pages(72.0, &de(json!({}))).unwrap();
    assert_eq!(not_yet["count"], 0);
    let dry = store
        .purge_deleted_pages(0.0, &de(json!({ "dryRun": true })))
        .unwrap();
    assert_eq!(strs(&dry["slugs"]), vec!["notes/a", "notes/b"]);
    assert_eq!(dry["pages"][0]["source_id"], "default");
    assert_eq!(
        store.get_all_slugs(&de(json!({}))).unwrap().len(),
        3,
        "a dry run removes nothing"
    );
    let negative = store
        .purge_deleted_pages(-5.0, &de(json!({ "dryRun": true })))
        .unwrap_err();
    assert_eq!(
        negative.code, "invalid_argument",
        "a negative age is refused"
    );
    let real = store
        .purge_deleted_pages(0.0, &de(json!({ "excludeIds": [id_of(&b)] })))
        .unwrap();
    assert_eq!(strs(&real["slugs"]), vec!["notes/a"]);
    assert_eq!(
        real["pages"].as_array().map(Vec::len),
        Some(1),
        "a real run lists what it purged"
    );
    assert_eq!(real["pages"][0]["slug"], "notes/a");
    assert_eq!(
        store.get_all_slugs(&de(json!({}))).unwrap(),
        vec!["notes/b", "notes/c"]
    );
}

#[test]
fn purge_deleted_pages_refuses_an_age_that_is_nan_negative_or_not_finite_and_deletes_nothing() {
    let dir = TempDir::new("ops-purge-nan");
    let store = open(&dir);
    put(&store, "notes/a", note("A", "a"));
    put(&store, "notes/b", note("B", "b"));
    store.soft_delete_page("notes/a", Some("default")).unwrap();
    store.soft_delete_page("notes/b", Some("default")).unwrap();
    for hours in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        -1.0,
        -72.0,
        -0.5,
    ] {
        for dry_run in [false, true] {
            let error = store
                .purge_deleted_pages(hours, &de(json!({ "dryRun": dry_run })))
                .expect_err("an age that is NaN, negative or not finite must be refused");
            assert_eq!(error.code, INVALID_ARGUMENT, "{hours} dryRun={dry_run}");
        }
    }
    assert_eq!(
        store.get_all_slugs(&de(json!({}))).unwrap().len(),
        2,
        "the tombstones are still there"
    );
    // 0 hours is still a valid age.
    let zero = store
        .purge_deleted_pages(0.0, &de(json!({ "dryRun": true })))
        .unwrap();
    assert!(zero["count"].as_u64().is_some());
}

#[test]
fn resolve_slugs_by_paths_returns_every_claimant_of_the_source() {
    let dir = TempDir::new("ops-paths");
    let store = open(&dir);
    // A second live claimant of one file is refused, so the tombstone claims the path first.
    put(
        &store,
        "notes/a-twin",
        json!({ "type": "note", "title": "T", "compiled_truth": "t", "source_path": "Notes/A File.md" }),
    );
    store
        .soft_delete_page("notes/a-twin", Some("default"))
        .unwrap();
    put(
        &store,
        "notes/a",
        json!({ "type": "note", "title": "A", "compiled_truth": "a", "source_path": "Notes/A File.md" }),
    );
    put(&store, "notes/b", note("B", "b"));
    let rows = store
        .resolve_slugs_by_paths(
            &["Notes/A File.md".to_string(), "notes/zzz.md".to_string()],
            &de(json!({ "sourceId": "default" })),
        )
        .unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "slug": "notes/a", "source_path": "Notes/A File.md", "live": true }),
            json!({ "slug": "notes/a-twin", "source_path": "Notes/A File.md", "live": false }),
        ]
    );
    let other = store
        .resolve_slugs_by_paths(
            &["Notes/A File.md".to_string()],
            &de(json!({ "sourceId": "work" })),
        )
        .unwrap();
    assert!(other.is_empty());
}

#[test]
fn find_pages_matches_name_prefix_and_glob_patterns() {
    let dir = TempDir::new("ops-find");
    let store = open(&dir);
    source(&store, "old");
    put(
        &store,
        "people/alice-example",
        json!({ "type": "person", "title": "Alice Example", "compiled_truth": "a" }),
    );
    put(
        &store,
        "people/charlie-example",
        json!({ "type": "person", "title": "Charlie Example", "compiled_truth": "c" }),
    );
    put(
        &store,
        "companies/acme-example",
        json!({ "type": "company", "title": "Acme", "compiled_truth": "x" }),
    );
    put(&store, "test/fixture", note("Fixture alice", "f"));
    put_in(
        &store,
        "old",
        "people/alice-old",
        json!({ "type": "person", "title": "Alice Old", "compiled_truth": "o" }),
    );
    store.set_source_archived("old", true).unwrap();
    let find = |q: Value| store.find_pages(&de(q)).unwrap();
    let name = find(
        json!({ "pattern": { "kind": "name", "like": "%alice%" }, "limit": 10, "excludeSlugPrefixes": ["test/"] }),
    );
    assert_eq!(
        slugs_of(name["rows"].as_array().unwrap()),
        vec!["people/alice-example"]
    );
    assert_eq!(name["total"], 1);
    let row = &name["rows"][0];
    assert_eq!(row["type"], "person");
    assert!(row["source_path"].is_null());
    assert_eq!(
        row["updated_at"].as_str().unwrap().len(),
        "2026-01-01T00:00:00.000000Z".len()
    );
    let prefix = find(
        json!({ "pattern": { "kind": "prefix", "like": "people/%" }, "limit": 1, "excludeSlugPrefixes": [] }),
    );
    assert_eq!(prefix["total"], 2);
    assert_eq!(
        slugs_of(prefix["rows"].as_array().unwrap()),
        vec!["people/alice-example"]
    );
    let glob = find(
        json!({ "pattern": { "kind": "glob", "like": "%example" }, "types": ["company"], "limit": 10, "excludeSlugPrefixes": [] }),
    );
    assert_eq!(
        slugs_of(glob["rows"].as_array().unwrap()),
        vec!["companies/acme-example"]
    );
    let zero = find(
        json!({ "pattern": { "kind": "glob", "like": "%" }, "limit": 0, "excludeSlugPrefixes": [] }),
    );
    assert_eq!(zero["total"], 0, "PGLite reads total off the first row");
    let error = store
        .find_pages(&de(
            json!({ "pattern": { "kind": "glob", "like": "%" }, "limit": -1 }),
        ))
        .unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
}

#[test]
fn find_pages_under_untrusted_hides_private_and_quarantined_pages() {
    let dir = TempDir::new("ops-find-untrusted");
    let store = open(&dir);
    put(
        &store,
        "people/alice-example",
        json!({ "type": "person", "title": "Alice", "compiled_truth": "a" }),
    );
    put(
        &store,
        "people/private-example",
        json!({ "type": "person", "title": "Private", "compiled_truth": "p",
            "frontmatter": { "visibility": "private" } }),
    );
    put(
        &store,
        "people/quarantined-example",
        json!({ "type": "person", "title": "Quarantined", "compiled_truth": "q",
            "frontmatter": { "quarantine": { "reason": "test" } } }),
    );
    let find = |untrusted: Value| {
        let found = store
            .find_pages(&de(
                json!({ "pattern": { "kind": "prefix", "like": "people/%" },
                "limit": 10, "excludeSlugPrefixes": [], "untrusted": untrusted }),
            ))
            .unwrap();
        (
            found["total"].clone(),
            slugs_of(found["rows"].as_array().unwrap()),
        )
    };
    let (total, rows) = find(Value::Null);
    assert_eq!(total, 3);
    assert_eq!(
        rows,
        vec![
            "people/alice-example",
            "people/private-example",
            "people/quarantined-example"
        ]
    );
    let (total, rows) = find(json!({ "live": true }));
    assert_eq!(total, 2, "a live read scope hides a quarantined page");
    assert_eq!(rows, vec!["people/alice-example", "people/private-example"]);
    let (total, rows) = find(json!({ "live": true,
        "excludePrivate": { "honorAliases": true, "entityPrivacy": true } }));
    assert_eq!(total, 1, "excludePrivate hides a private page");
    assert_eq!(rows, vec!["people/alice-example"]);
}

#[test]
fn count_pages_by_counts_visible_pages_with_and_without_groups() {
    let dir = TempDir::new("ops-count");
    let store = open(&dir);
    source(&store, "work");
    put(
        &store,
        "people/alice-example",
        json!({ "type": "person", "title": "A", "compiled_truth": "a" }),
    );
    put(
        &store,
        "people/charlie-example",
        json!({ "type": "person", "title": "C", "compiled_truth": "c" }),
    );
    put(
        &store,
        "companies/acme-example",
        json!({ "type": "company", "title": "X", "compiled_truth": "x" }),
    );
    put(&store, "notes/a", note("N", "n"));
    put_in(
        &store,
        "work",
        "people/alice-example",
        json!({ "type": "person", "title": "A", "compiled_truth": "a" }),
    );
    store.soft_delete_page("notes/a", Some("default")).unwrap();
    let plain = store.count_pages_by(&de(json!({}))).unwrap();
    assert_eq!(
        plain["bySourceType"],
        json!([
            { "source_id": "default", "type": "company", "pages": 1 },
            { "source_id": "default", "type": "person", "pages": 2 },
            { "source_id": "work", "type": "person", "pages": 1 },
        ])
    );
    assert_eq!(plain["total"], json!({ "pages": 4, "distinct_slugs": 3 }));
    assert_eq!(plain["byTypeGroup"], json!([]));
    let grouped = store
        .count_pages_by(&de(
            json!({ "typeGroups": { "person": "people", "company": "other" } }),
        ))
        .unwrap();
    assert_eq!(
        grouped["byTypeGroup"],
        json!([
            { "group": "other", "pages": 1, "distinct_slugs": 1 },
            { "group": "people", "pages": 3, "distinct_slugs": 2 },
        ])
    );
    let scoped = store
        .count_pages_by(&de(json!({ "sourceId": "work" })))
        .unwrap();
    assert_eq!(scoped["total"], json!({ "pages": 1, "distinct_slugs": 1 }));
    let future = store
        .count_pages_by(&de(json!({ "since": "2999-01-01T00:00:00Z" })))
        .unwrap();
    assert_eq!(future["total"], json!({ "pages": 0, "distinct_slugs": 0 }));
    let error = store
        .count_pages_by(&de(json!({ "since": "last week" })))
        .unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
}

#[test]
fn samplers_pick_live_pages_by_prefix_and_at_random() {
    let dir = TempDir::new("ops-sample");
    let store = open(&dir);
    put(&store, "wiki/vc/one", note("1", "1"));
    put(&store, "wiki/vc/two", note("2", "2"));
    put(&store, "wiki/vc/three", note("3", "3"));
    put(&store, "wiki/bio/one", note("b", "b"));
    put(&store, "notes/a", note("n", "n"));
    store
        .soft_delete_page("wiki/vc/two", Some("default"))
        .unwrap();
    let link: AddLinkOptions = de(json!({ "linkType": "mentions" }));
    store.add_link("notes/a", "wiki/vc/three", &link).unwrap();
    let prefixed = store
        .list_prefix_sampled_pages(&de(json!({ "prefixes": ["wiki/vc", "wiki/bio"] })))
        .unwrap();
    let view: Vec<String> = prefixed
        .iter()
        .map(|r| {
            format!(
                "{}:{}:{}",
                r["prefix"].as_str().unwrap(),
                r["slug"].as_str().unwrap(),
                r["connection_count"]
            )
        })
        .collect();
    assert_eq!(
        view,
        vec!["wiki/bio:wiki/bio/one:0", "wiki/vc:wiki/vc/three:1"]
    );
    assert!(prefixed[0]["last_retrieved_at"].is_null());
    assert!(prefixed[0]["representative_chunk_id"].is_null());
    let excluded = store
        .list_prefix_sampled_pages(&de(
            json!({ "prefixes": ["wiki/vc"], "excludeSlugs": ["wiki/vc/three"] }),
        ))
        .unwrap();
    assert_eq!(slugs_of(&excluded), vec!["wiki/vc/one"]);
    let none = store
        .list_prefix_sampled_pages(&de(json!({ "prefixes": ["wiki/vc"], "sourceIds": [] })))
        .unwrap();
    assert!(
        none.is_empty(),
        "an empty sourceIds array scopes to nothing"
    );
    let sample = |seed: Value| {
        let mut s = slugs_of(
            &store
                .list_corpus_sample(&de(
                    json!({ "n": 10, "excludeSlugs": ["notes/a"], "seed": seed }),
                ))
                .unwrap(),
        );
        s.sort();
        s
    };
    assert_eq!(
        sample(json!(0.5)),
        vec!["wiki/bio/one", "wiki/vc/one", "wiki/vc/three"]
    );
    let first = slugs_of(
        &store
            .list_corpus_sample(&de(json!({ "n": 2, "seed": 0.25 })))
            .unwrap(),
    );
    let again = slugs_of(
        &store
            .list_corpus_sample(&de(json!({ "n": 2, "seed": 0.25 })))
            .unwrap(),
    );
    assert_eq!(first.len(), 2);
    assert_eq!(first, again, "a seed gives the same pick");
    assert!(
        store
            .list_corpus_sample(&de(json!({ "n": 0 })))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn marker_reads_and_dates_follow_the_read_scope() {
    let dir = TempDir::new("ops-markers");
    let store = open(&dir);
    let flagged = put(
        &store,
        "notes/flagged",
        json!({ "type": "note", "title": "F", "compiled_truth": "f", "frontmatter": { "content_flag": { "reason": "spam" } } }),
    );
    let empty_reason = put(
        &store,
        "notes/empty",
        json!({ "type": "note", "title": "E", "compiled_truth": "e", "frontmatter": { "content_flag": { "reason": "" } } }),
    );
    let auto = put(
        &store,
        "notes/auto",
        json!({ "type": "note", "title": "A", "compiled_truth": "a", "frontmatter": { "status": "unverified", "provenance": "auto-extracted" } }),
    );
    let quarantined = put(
        &store,
        "notes/q",
        json!({ "type": "note", "title": "Q", "compiled_truth": "q", "frontmatter": { "status": "draft", "quarantine": true, "content_flag": { "reason": "r", "detail": "d" } } }),
    );
    let ids = vec![
        id_of(&flagged),
        id_of(&empty_reason),
        id_of(&auto),
        id_of(&quarantined),
        999_999,
    ];
    let flags = store
        .get_content_flags_by_page_ids(&ids, &de(json!({})))
        .unwrap();
    assert_eq!(
        flags,
        vec![
            json!({ "id": id_of(&flagged), "reason": "spam", "detail": "" }),
            json!({ "id": id_of(&quarantined), "reason": "r", "detail": "d" }),
        ]
    );
    let live_flags = store
        .get_content_flags_by_page_ids(&ids, &de(json!({ "live": true })))
        .unwrap();
    assert_eq!(live_flags.len(), 1, "a scope hides quarantined pages");
    let states = store
        .get_unverified_extraction_page_ids(&ids, &de(json!({})))
        .unwrap();
    assert_eq!(
        states,
        vec![
            json!({ "id": id_of(&auto), "status": "unverified", "unverified": true }),
            json!({ "id": id_of(&quarantined), "status": "draft", "unverified": false }),
        ]
    );
    let dated = put(
        &store,
        "ts/dated",
        json!({ "type": "note", "title": "D", "compiled_truth": "d", "effective_date": "2024-05-01T00:00:00Z" }),
    );
    put(&store, "ts/undated", note("U", "u"));
    let stamps = store
        .get_page_timestamps(&[
            "ts/dated".to_string(),
            "ts/undated".to_string(),
            "ts/missing".to_string(),
        ])
        .unwrap();
    assert_eq!(slugs_of(&stamps), vec!["ts/dated", "ts/undated"]);
    assert_eq!(stamps[0]["ts"], dated["updated_at"]);
    let refs = de::<Vec<gbrain_store::page_ops::PageRef>>(json!([
        { "slug": "ts/dated", "source_id": "default" },
        { "slug": "ts/undated", "source_id": "default" },
        { "slug": "ts/dated", "source_id": "no-such" },
    ]));
    let dates = store.get_effective_dates(&refs, &de(json!({}))).unwrap();
    assert_eq!(slugs_of(&dates), vec!["ts/dated", "ts/undated"]);
    assert_eq!(dates[0]["ts"], "2024-05-01T00:00:00.000000Z");
    store
        .soft_delete_page("ts/undated", Some("default"))
        .unwrap();
    let live = store
        .get_effective_dates(&refs, &de(json!({ "live": true })))
        .unwrap();
    assert_eq!(slugs_of(&live), vec!["ts/dated"]);
}

#[test]
fn marker_reads_under_exclude_private_hide_the_pages_the_policy_hides() {
    let dir = TempDir::new("ops-private");
    let store = open(&dir);
    let marked = |frontmatter: Value| json!({ "type": "note", "title": "T", "compiled_truth": "t", "frontmatter": frontmatter });
    let flag = json!({ "reason": "spam", "detail": "d" });
    let open_page = put(
        &store,
        "notes/open",
        marked(json!({ "content_flag": flag, "status": "draft" })),
    );
    let by_visibility = put(
        &store,
        "notes/visibility",
        marked(json!({ "visibility": "private", "content_flag": flag, "status": "draft" })),
    );
    let by_access = put(
        &store,
        "notes/access",
        marked(json!({ "access": "private", "content_flag": flag, "status": "draft" })),
    );
    let public_with_access = put(
        &store,
        "notes/public",
        marked(
            json!({ "visibility": "public", "access": "private", "content_flag": flag, "status": "draft" }),
        ),
    );
    let ids = vec![
        id_of(&open_page),
        id_of(&by_visibility),
        id_of(&by_access),
        id_of(&public_with_access),
    ];
    let read = |scope: Value| {
        let scope = de(scope);
        let flags = store.get_content_flags_by_page_ids(&ids, &scope).unwrap();
        let states = store
            .get_unverified_extraction_page_ids(&ids, &scope)
            .unwrap();
        let ids_of = |rows: &[Value]| {
            rows.iter()
                .map(|r| r["id"].as_i64().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids_of(&flags),
            ids_of(&states),
            "both reads apply one policy"
        );
        ids_of(&flags)
    };
    assert_eq!(read(json!({})), ids);
    assert_eq!(
        read(json!({ "live": true })),
        ids,
        "a scope alone hides nothing private"
    );
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn"});
    // `visibility` decides when a page has it; the alias keys only count for a page without one.
    assert_eq!(
        read(json!({ "live": true, "excludePrivate": policy })),
        vec![ids[0], ids[3]]
    );
    // Without the alias keys (`honorAliases` false) only `visibility` hides a page.
    let visibility_only = json!({ "honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn"});
    assert_eq!(
        read(json!({ "live": true, "excludePrivate": visibility_only })),
        vec![ids[0], ids[2], ids[3]]
    );
    // The policy adds to the source scope.
    assert_eq!(
        read(json!({ "live": true, "sourceId": "default", "excludePrivate": policy })),
        vec![ids[0], ids[3]]
    );
    assert!(
        read(json!({ "live": true, "sourceId": "other", "excludePrivate": policy })).is_empty()
    );
}

#[test]
fn revert_to_version_restores_body_and_frontmatter_without_a_snapshot() {
    let dir = TempDir::new("ops-revert");
    let store = open(&dir);
    source(&store, "work");
    put(
        &store,
        "notes/rev",
        json!({ "type": "note", "title": "R", "compiled_truth": "first", "frontmatter": { "k": 1 } }),
    );
    let snap = store.create_version("notes/rev", Some("default")).unwrap();
    let version_id = snap["id"].as_i64().unwrap();
    put(
        &store,
        "notes/rev",
        json!({ "type": "note", "title": "R", "compiled_truth": "second", "frontmatter": { "k": 2 } }),
    );
    put_in(
        &store,
        "work",
        "notes/rev",
        json!({ "type": "note", "title": "W", "compiled_truth": "work" }),
    );
    let read = |src: &str| {
        store
            .read_page_snapshot("notes/rev", &de::<ReadScope>(json!({ "sourceId": src })))
            .unwrap()
            .unwrap()
    };
    let before = read("default");
    let versions_before = store
        .get_versions("notes/rev", &de(json!({ "sourceId": "default" })))
        .unwrap()
        .len();
    store
        .revert_to_version("notes/rev", version_id, &de(json!({})))
        .unwrap();
    let after = read("default");
    assert_eq!(after["page"]["compiled_truth"], "first");
    assert_eq!(after["page"]["frontmatter"], json!({ "k": 1 }));
    assert_ne!(after["revision"], before["revision"]);
    assert_eq!(
        read("work")["page"]["compiled_truth"],
        "work",
        "a version belongs to one page"
    );
    let versions_after = store
        .get_versions("notes/rev", &de(json!({ "sourceId": "default" })))
        .unwrap()
        .len();
    assert_eq!(
        versions_after, versions_before,
        "PGLite writes no snapshot on revert"
    );
    store
        .revert_to_version("notes/rev", version_id, &de(json!({ "sourceId": "work" })))
        .unwrap();
    assert_eq!(read("work")["page"]["compiled_truth"], "work");
    store
        .revert_to_version("notes/rev", -1, &de(json!({})))
        .unwrap();
    store
        .revert_to_version("notes/missing", version_id, &de(json!({})))
        .unwrap();
}

#[test]
fn delete_pages_scrubs_the_deleted_slugs_from_captured_eval_candidates() {
    use gbrain_store::eval_capture::{EvalCandidateInput, ListEvalCandidatesOptions};
    let dir = TempDir::new("ops-delete-eval");
    let store = open(&dir);
    source(&store, "work");
    put(&store, "notes/a", note("A", "a"));
    put(&store, "notes/b", note("B", "b"));
    put(&store, "notes/shared", note("S", "s"));
    put_in(&store, "work", "notes/shared", note("S", "s"));
    let log = |sources: Value| {
        let input: EvalCandidateInput = de(json!({
            "tool_name": "query", "query": "q",
            "retrieved_slugs": ["notes/b", "notes/a", "notes/shared", "notes/a"],
            "retrieved_chunk_ids": [], "source_ids": sources, "expand_enabled": false,
            "detail": null, "detail_resolved": null, "vector_enabled": false,
            "expansion_applied": false, "latency_ms": 1, "remote": false,
            "job_id": null, "subagent_id": null, "embedding_column": "embedding",
        }));
        store.log_eval_candidate(&input).unwrap();
    };
    log(json!(["default"]));
    log(json!(["default", "work"]));
    log(json!([]));
    let gone = store
        .delete_pages(
            &["notes/a".to_string(), "notes/shared".to_string()],
            &de(json!({ "sourceId": "default" })),
        )
        .unwrap();
    assert_eq!(gone, vec!["notes/a", "notes/shared"]);
    let opts: ListEvalCandidatesOptions = de(json!({ "limit": 10 }));
    let rows = store.list_eval_candidates(&opts).unwrap();
    let by_sources = |want: Value| {
        rows.iter().find(|r| r["source_ids"] == want).unwrap()["retrieved_slugs"].clone()
    };
    assert_eq!(by_sources(json!(["default"])), json!(["notes/b"]));
    // `work` still holds notes/shared, so the slug stays for a candidate that covers it.
    assert_eq!(
        by_sources(json!(["default", "work"])),
        json!(["notes/b", "notes/shared"])
    );
    // No source_ids: PGLite's `$1 = ANY('{}')` is false, so the candidate is not changed.
    assert_eq!(
        by_sources(json!([])),
        json!(["notes/b", "notes/a", "notes/shared", "notes/a"])
    );
}
