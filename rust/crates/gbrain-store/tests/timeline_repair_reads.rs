//! The timeline repair reads and row rewrite (`timeline_queries/repair_reads.rs`), matched to the SQL in
//! `src/core/engine-sql/timeline-repair-reads.ts`: the page scans of `gbrain repair timeline`,
//! `timeline-comments`, `timeline-order` and `connector-fences`, the retraction check's version reads, and
//! the comment-row rewrite.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use gbrain_store::timeline_queries::{
    ConnectorFenceInput, TimelineHistoryInput, TimelineMarkupInput, TimelinePageScanInput,
    TimelineRowRewrite,
};
use serde_json::{Map, Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(store: &Store, slug: &str, source: &str, body: &str, timeline: &str) -> i64 {
    let input: PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": body, "timeline": timeline, "frontmatter": {},
    }));
    store
        .put_page(
            slug,
            &input,
            &args::<PutPageOptions>(json!({"sourceId": source})),
        )
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn entry(store: &Store, slug: &str, source: &str, summary: &str) {
    let e: TimelineInput =
        args(json!({"date": "2024-03-01", "source": "manual", "summary": summary, "detail": ""}));
    let o: AddTimelineOptions = args(json!({"sourceId": source}));
    assert!(store.add_timeline_entry(slug, &e, &o).unwrap());
}

fn ids(rows: &[Value]) -> Vec<i64> {
    rows.iter().map(|r| r["id"].as_i64().unwrap()).collect()
}

#[test]
fn history_pages_hold_an_own_row_after_the_cursor_and_ids_select_directly() {
    let dir = TempDir::new("timeline-repair-history");
    let store = open(&dir);
    let a = put(&store, "a", "default", "a body", "");
    let b = put(&store, "b", "default", "b body", "");
    let c = put(&store, "c", "default", "c body", "");
    entry(&store, "a", "default", "first");
    entry(&store, "c", "default", "third");
    let scan = |after: i64, limit: u64| {
        store
            .list_timeline_history_pages(&args::<TimelineHistoryInput>(
                json!({"sourceIds": ["default"], "afterId": after, "limit": limit}),
            ))
            .unwrap()
    };
    assert_eq!(ids(&scan(0, 10)), vec![a, c]);
    assert_eq!(ids(&scan(a, 10)), vec![c]);
    assert_eq!(ids(&scan(0, 1)), vec![a]);
    let direct = store
        .list_timeline_history_pages(&args::<TimelineHistoryInput>(
            json!({"sourceIds": ["default"], "ids": [b, c]}),
        ))
        .unwrap();
    assert_eq!(ids(&direct), vec![b, c]);
    assert_eq!(direct[0]["slug"], "b");
    assert_eq!(direct[0]["compiled_truth"], "b body");
    let other = store
        .list_timeline_history_pages(&args::<TimelineHistoryInput>(
            json!({"sourceIds": ["elsewhere"], "afterId": 0, "limit": 10}),
        ))
        .unwrap();
    assert!(other.is_empty());
}

#[test]
fn version_witnesses_are_newest_first_and_the_body_carries_md5_parts() {
    let dir = TempDir::new("timeline-repair-versions");
    let store = open(&dir);
    let id = put(&store, "v", "default", "head text", "tail text");
    store.create_version("v", None).unwrap();
    store.create_version("v", None).unwrap();
    let witnesses = store
        .list_timeline_version_witnesses("default", "v")
        .unwrap();
    assert_eq!(witnesses.len(), 2);
    let (newest, oldest) = (
        witnesses[0]["id"].as_i64().unwrap(),
        witnesses[1]["id"].as_i64().unwrap(),
    );
    assert!(newest > oldest);
    assert_eq!(witnesses[0]["page_id"].as_i64(), Some(id));
    assert_eq!(witnesses[0]["body_storage"], "inline");
    let body = store.read_timeline_version_body(id, newest).unwrap();
    assert_eq!(body["compiled_truth"], "head text");
    assert_eq!(body["timeline"], "tail text");
    // md5('head text'), md5('tail text').
    assert_eq!(body["head"], "fd4ddab1f3f1fa7645984ae90f8c9c83");
    assert_eq!(body["tail"], "ddefbc09ab6f003e1427976d186b012d");
    assert!(
        store
            .read_timeline_version_body(id + 1, newest)
            .unwrap()
            .is_null()
    );
    assert!(
        store
            .read_timeline_version_body(id, newest + 100)
            .unwrap()
            .is_null()
    );
    assert!(
        store
            .list_timeline_version_witnesses("default", "missing")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn markup_rows_and_the_rewrite_touch_only_own_rows_with_comment_markup() {
    let dir = TempDir::new("timeline-repair-markup");
    let store = open(&dir);
    let p = put(&store, "m", "default", "body", "");
    let q = put(&store, "n", "default", "body", "");
    entry(&store, "m", "default", "<!-- AUTO:slack END -->");
    entry(&store, "m", "default", "plain");
    entry(&store, "n", "default", "tail -->");
    let by_page = store
        .list_timeline_markup_rows(&args::<TimelineMarkupInput>(json!({"pageId": p})))
        .unwrap();
    assert_eq!(by_page.len(), 1);
    assert_eq!(by_page[0]["summary"], "<!-- AUTO:slack END -->");
    assert_eq!(by_page[0]["slug"], "m");
    assert_eq!(by_page[0]["body_storage"], "inline");
    let all = store
        .list_timeline_markup_rows(&args::<TimelineMarkupInput>(
            json!({"sourceIds": ["default"], "afterId": 0}),
        ))
        .unwrap();
    assert_eq!(
        all.iter()
            .map(|r| r["page_id"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![p, q]
    );
    let after = store
        .list_timeline_markup_rows(&args::<TimelineMarkupInput>(
            json!({"sourceIds": ["default"], "afterId": p}),
        ))
        .unwrap();
    assert_eq!(after.len(), 1);

    let row = by_page[0]["id"].as_i64().unwrap();
    store
        .rewrite_timeline_row(
            p,
            &args::<TimelineRowRewrite>(
                json!({"id": row, "source": "slack", "summary": "clean", "detail": "d"}),
            ),
        )
        .unwrap();
    // A row of another page is left alone.
    store
        .rewrite_timeline_row(
            q,
            &args::<TimelineRowRewrite>(
                json!({"id": row, "source": "x", "summary": "x", "detail": "x"}),
            ),
        )
        .unwrap();
    let stored = store.list_stored_timeline_rows_ordered(p).unwrap();
    let rewritten = stored
        .iter()
        .find(|r| r["id"].as_i64() == Some(row))
        .unwrap();
    assert_eq!(rewritten["summary"], "clean");
    assert_eq!(rewritten["source"], "slack");
    assert!(
        store
            .list_timeline_markup_rows(&args::<TimelineMarkupInput>(json!({"pageId": p})))
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .rewrite_timeline_row(
                p,
                &args::<TimelineRowRewrite>(
                    json!({"id": row, "source": "a\u{0}", "summary": "s", "detail": ""})
                )
            )
            .is_err()
    );
}

#[test]
fn page_scans_match_marker_bullet_and_connector_fence_shapes() {
    let dir = TempDir::new("timeline-repair-scans");
    let store = open(&dir);
    let mut config = Map::new();
    config.insert("kind".into(), json!("google"));
    store
        .insert_source("gc-example", "gc-example", None, &config)
        .unwrap();
    let marker = put(
        &store,
        "marker",
        "default",
        "x <!-- gbrain:materialized --> y",
        "",
    );
    let bullet = put(&store, "bullet", "default", "body", "- **2024-03-01** | a");
    let plain = put(&store, "plain", "default", "body", "");
    let fenced = put(
        &store,
        "fenced",
        "gc-example",
        "body",
        "<!-- gbrain:facts:begin -->\n<!-- gbrain:facts:end -->",
    );
    put(&store, "unfenced", "gc-example", "body", "- plain");
    let fenced_default = put(
        &store,
        "fenced-default",
        "default",
        "body",
        "<!-- gbrain:takes:begin -->",
    );
    let _ = (plain, fenced_default);

    let scan = |after: i64| TimelinePageScanInput {
        source_ids: vec!["default".into()],
        after_id: after,
        slugs: vec![],
        limit: None,
    };
    assert_eq!(
        ids(&store.list_materialized_marker_pages(&scan(0)).unwrap()),
        vec![marker]
    );
    assert!(
        store
            .list_materialized_marker_pages(&scan(marker))
            .unwrap()
            .is_empty()
    );

    assert_eq!(
        ids(&store.list_date_bullet_pages(&scan(0)).unwrap()),
        vec![bullet]
    );
    let by_slug = TimelinePageScanInput {
        slugs: vec!["marker".into()],
        ..scan(0)
    };
    assert!(store.list_date_bullet_pages(&by_slug).unwrap().is_empty());
    let limited = TimelinePageScanInput {
        limit: Some(1),
        ..scan(0)
    };
    assert_eq!(store.list_date_bullet_pages(&limited).unwrap().len(), 1);

    let fences = |segmented: bool| {
        store
            .list_connector_fence_pages(&args::<ConnectorFenceInput>(json!({
                "sourceIds": ["default", "gc-example"], "kinds": ["google"], "segmented": segmented,
            })))
            .unwrap()
    };
    assert_eq!(ids(&fences(false)), vec![fenced]);
    assert!(fences(true).is_empty());
    let other_kind = store
        .list_connector_fence_pages(&args::<ConnectorFenceInput>(
            json!({"sourceIds": ["gc-example"], "kinds": ["slack"]}),
        ))
        .unwrap();
    assert!(other_kind.is_empty());
}
