//! Links and timeline: what the PGLite replay (`graph_parity.rs`) cannot show. Durability
//! across a reopen, the row caps, and the inputs and options the Rust engine refuses.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::links::{
    AddLinkOptions, LinkBatchInput, LinkScope, PathOptions, TRAVERSE_PATH_ROW_CAP,
    TraverseGraphOptions,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput, TimelineOptions};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": format!("{slug} body")}),
    )
    .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

fn link(store: &Store, from: &str, to: &str, link_type: &str) {
    let options: AddLinkOptions =
        serde_json::from_value(json!({"linkType": link_type, "context": "c"})).unwrap();
    store.add_link(from, to, &options).unwrap();
}

fn entry(date: &str, summary: &str) -> TimelineInput {
    serde_json::from_value(json!({"date": date, "summary": summary})).unwrap()
}

fn paths(depth: i64, direction: &str) -> PathOptions {
    serde_json::from_value(json!({"depth": depth, "direction": direction})).unwrap()
}

#[test]
fn links_and_timeline_survive_a_reopen() {
    let dir = TempDir::new("graph-reopen");
    let (links, backlinks, walk, timeline);
    {
        let store = open(&dir);
        for slug in ["a/one", "a/two", "a/three"] {
            put(&store, slug);
        }
        link(&store, "a/one", "a/two", "cites");
        link(&store, "a/two", "a/three", "cites");
        assert!(
            store
                .add_timeline_entry(
                    "a/one",
                    &entry("2026-01-02", "met"),
                    &AddTimelineOptions::default()
                )
                .unwrap()
        );
        links = store.get_links("a/one", &LinkScope::default()).unwrap();
        backlinks = store
            .get_backlinks("a/three", &LinkScope::default())
            .unwrap();
        walk = store
            .traverse_graph("a/one", Some(3), &TraverseGraphOptions::default())
            .unwrap();
        timeline = store
            .get_timeline("a/one", &TimelineOptions::default())
            .unwrap();
    }
    let store = open(&dir);
    assert_eq!(links.len(), 1);
    assert_eq!(
        store.get_links("a/one", &LinkScope::default()).unwrap(),
        links
    );
    assert_eq!(
        store
            .get_backlinks("a/three", &LinkScope::default())
            .unwrap(),
        backlinks
    );
    assert_eq!(
        store
            .traverse_graph("a/one", Some(3), &TraverseGraphOptions::default())
            .unwrap(),
        walk
    );
    assert_eq!(walk.len(), 3);
    assert_eq!(
        store
            .get_timeline("a/one", &TimelineOptions::default())
            .unwrap(),
        timeline
    );
    // the dedup key and the id counter are durable too
    assert!(
        !store
            .add_timeline_entry(
                "a/one",
                &entry("2026-01-02", "met"),
                &AddTimelineOptions::default()
            )
            .unwrap()
    );
    assert!(
        store
            .add_timeline_entry(
                "a/one",
                &entry("2026-01-03", "again"),
                &AddTimelineOptions::default()
            )
            .unwrap()
    );
    let ids: Vec<u64> = store
        .get_timeline("a/one", &TimelineOptions::default())
        .unwrap()
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![3, 1],
        "the deduped add took id 2, as a Postgres serial does"
    );
}

#[test]
fn a_walk_stops_at_its_depth_and_visits_a_cycle_once() {
    let dir = TempDir::new("graph-cycle");
    let store = open(&dir);
    for slug in ["c/a", "c/b", "c/c"] {
        put(&store, slug);
    }
    link(&store, "c/a", "c/b", "");
    link(&store, "c/b", "c/c", "");
    link(&store, "c/c", "c/a", "");
    let depths = |depth: i64| -> Vec<(String, u64)> {
        store
            .traverse_graph("c/a", Some(depth), &TraverseGraphOptions::default())
            .unwrap()
            .iter()
            .map(|n| {
                (
                    n["slug"].as_str().unwrap().to_string(),
                    n["depth"].as_u64().unwrap(),
                )
            })
            .collect()
    };
    assert_eq!(depths(1), vec![("c/a".into(), 0), ("c/b".into(), 1)]);
    assert_eq!(
        depths(10),
        vec![("c/a".into(), 0), ("c/b".into(), 1), ("c/c".into(), 2)]
    );
    let edges = store.traverse_paths("c/a", &paths(3, "both")).unwrap();
    assert_eq!(edges.len(), 3, "each edge of the cycle once: {edges:?}");
}

#[test]
fn traverse_paths_detailed_reports_truncation_at_the_row_cap() {
    let dir = TempDir::new("graph-cap");
    let store = open(&dir);
    put(&store, "hub");
    let spokes: Vec<String> = (0..=TRAVERSE_PATH_ROW_CAP)
        .map(|i| format!("s/{i:05}"))
        .collect();
    for slug in &spokes {
        put(&store, slug);
    }
    let batch: Vec<LinkBatchInput> = spokes
        .iter()
        .map(|to| {
            serde_json::from_value(json!({"from_slug": "hub", "to_slug": to, "link_type": "x"}))
                .unwrap()
        })
        .collect();
    assert_eq!(store.add_links_batch(&batch).unwrap(), spokes.len() as u64);
    let detailed = store
        .traverse_paths_detailed("hub", &paths(1, "out"))
        .unwrap();
    assert_eq!(detailed["truncated"], true);
    assert_eq!(
        detailed["paths"].as_array().unwrap().len(),
        TRAVERSE_PATH_ROW_CAP
    );
    // one spoke fewer fits exactly and is not truncated
    let options = serde_json::from_value(json!({"linkType": "x"})).unwrap();
    assert_eq!(store.remove_link("hub", &spokes[0], &options).unwrap(), 1);
    let detailed = store
        .traverse_paths_detailed("hub", &paths(1, "out"))
        .unwrap();
    assert_eq!(detailed["truncated"], false);
    assert_eq!(
        detailed["paths"].as_array().unwrap().len(),
        TRAVERSE_PATH_ROW_CAP
    );
}

#[test]
fn a_nul_byte_is_refused_in_a_key_and_stripped_from_free_text() {
    // Postgres refuses a NUL in text (22021); PGLite strips it from the free-text fields
    // first (`sanitizeForJsonb` on context, summary, detail and source), so only the key
    // columns reach the refusal.
    let dir = TempDir::new("graph-nul");
    let store = open(&dir);
    put(&store, "n/a");
    put(&store, "n/b");
    let options: AddLinkOptions = serde_json::from_value(json!({"linkType": "a\u{0}b"})).unwrap();
    let error = store.add_link("n/a", "n/b", &options).unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
    let error = store
        .add_timeline_entry(
            "n/\u{0}a",
            &entry("2026-01-01", "x"),
            &AddTimelineOptions::default(),
        )
        .unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
    assert!(
        store
            .get_links("n/a", &LinkScope::default())
            .unwrap()
            .is_empty()
    );

    let options: AddLinkOptions =
        serde_json::from_value(json!({"context": "be\u{0}fore"})).unwrap();
    store.add_link("n/a", "n/b", &options).unwrap();
    assert_eq!(
        store.get_links("n/a", &LinkScope::default()).unwrap()[0]["context"],
        "before"
    );
    assert!(
        store
            .add_timeline_entry(
                "n/a",
                &entry("2026-01-01", "x\u{0}y"),
                &AddTimelineOptions::default()
            )
            .unwrap()
    );
    assert_eq!(
        store
            .get_timeline("n/a", &TimelineOptions::default())
            .unwrap()[0]["summary"],
        "xy"
    );
}

#[test]
fn the_page_option_of_a_walk_is_refused_and_a_bad_temporal_date_fails() {
    let dir = TempDir::new("graph-refused");
    let store = open(&dir);
    put(&store, "r/a");
    let refused = |result: Result<Value>, what: &str| {
        let error = result.expect_err(what);
        assert_eq!(error.code, INVALID_ARGUMENT, "{what}: {error}");
        error.message
    };
    let page: PathOptions = serde_json::from_value(json!({"page": {"after": 1}})).unwrap();
    refused(
        store.traverse_paths_detailed("r/a", &page),
        "traversePathsDetailed page",
    );
    let bad = json!({"temporal": {"asOf": "2026-02-30"}});
    let walk: TraverseGraphOptions = serde_json::from_value(bad.clone()).unwrap();
    assert_eq!(
        refused(
            store.traverse_graph("r/a", Some(1), &walk).map(Value::from),
            "traverseGraph bad asOf",
        ),
        "temporal edge filter: invalid date \"2026-02-30\""
    );
    let path: PathOptions = serde_json::from_value(bad).unwrap();
    refused(
        store.traverse_paths_detailed("r/a", &path),
        "traversePathsDetailed bad asOf",
    );
    // status 'all' with no window filters nothing, so its date is never read.
    let all: TraverseGraphOptions =
        serde_json::from_value(json!({"temporal": {"status": "all", "asOf": "never"}})).unwrap();
    assert_eq!(store.traverse_graph("r/a", Some(1), &all).unwrap().len(), 1);
}

#[test]
fn a_page_policy_hides_private_seeds_endpoints_and_origins() {
    let dir = TempDir::new("graph-private");
    let store = open(&dir);
    for slug in ["p/open", "p/hub", "p/other"] {
        put(&store, slug);
    }
    let private: PageInput = serde_json::from_value(json!({
        "type": "note", "title": "private", "compiled_truth": "private body",
        "frontmatter": {"visibility": "private"},
    }))
    .unwrap();
    store
        .put_page("p/private", &private, &PutPageOptions::default())
        .unwrap();
    link(&store, "p/open", "p/hub", "cites");
    link(&store, "p/private", "p/hub", "cites");
    let batch: Vec<LinkBatchInput> = serde_json::from_value(json!([{
        "from_slug": "p/other", "to_slug": "p/hub", "link_type": "cites",
        "link_source": "frontmatter", "origin_slug": "p/private", "origin_field": "refs",
    }]))
    .unwrap();
    store.add_links_batch(&batch).unwrap();
    let policy = json!({"honorAliases": true, "entityPrivacy": true});
    let scope: LinkScope = serde_json::from_value(json!({"excludePrivate": policy})).unwrap();
    let from = |rows: Vec<Value>| -> Vec<String> {
        let mut out: Vec<String> = rows
            .iter()
            .map(|r| r["from_slug"].as_str().unwrap().to_string())
            .collect();
        out.sort();
        out
    };
    assert_eq!(
        from(store.get_backlinks("p/hub", &LinkScope::default()).unwrap()),
        ["p/open", "p/other", "p/private"]
    );
    assert_eq!(
        from(store.get_backlinks("p/hub", &scope).unwrap()),
        ["p/open"]
    );
    assert!(store.get_links("p/private", &scope).unwrap().is_empty());
    let walk: TraverseGraphOptions =
        serde_json::from_value(json!({"excludePrivate": policy})).unwrap();
    assert!(
        store
            .traverse_graph("p/private", Some(2), &walk)
            .unwrap()
            .is_empty()
    );
    let path: PathOptions =
        serde_json::from_value(json!({"excludePrivate": policy, "direction": "in", "depth": 2}))
            .unwrap();
    let edges = store.traverse_paths_detailed("p/hub", &path).unwrap();
    let froms: Vec<&str> = edges["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["from_slug"].as_str().unwrap())
        .collect();
    assert_eq!(froms, ["p/open"]);
}
