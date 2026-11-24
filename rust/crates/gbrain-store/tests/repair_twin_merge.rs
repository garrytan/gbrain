//! The twin-merge moves (`repair_twin_merge.rs`): `moveTwinRelationships`, `moveTwinPageChildren`, `moveTwinFacts`.
//! The PGLite and Postgres parity cases are in test/engine-parity/repair-twin-merge.test.ts; these cover what they
//! cannot show: the indexes the moves keep (the link unique key, the backlinks, the event index, the dedup key), the
//! revisions a tag move advances, the refusals, and that a refused move writes nothing.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::facts::{FactQuery, InsertFactsArgs};
use gbrain_store::link_queries::{ManualWriteInput, RelationshipKey};
use gbrain_store::links::{AddLinkOptions, LinkScope};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::repair_twin_merge::{TwinMergeIds, TwinPageChildrenMove};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput, TimelineOptions};
use gbrain_store::timeline_queries::EventProjectionInput;
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    (dir, store)
}

fn put(store: &Store, slug: &str) -> u64 {
    let input: PageInput = args(
        json!({ "type": "note", "title": slug, "compiled_truth": format!("{slug} body"), "timeline": "" }),
    );
    let options: PutPageOptions = args(json!({ "sourceId": "default" }));
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn snapshot(store: &Store, slug: &str) -> Value {
    let scope = ReadScope {
        source_id: Some("default".into()),
        include_deleted: true,
        ..ReadScope::default()
    };
    store.read_page_snapshot(slug, &scope).unwrap().unwrap()["page"].clone()
}

fn link(store: &Store, from: &str, to: &str, kind: &str, source: &str, origin: Option<&str>) {
    let options: AddLinkOptions = args(
        json!({ "context": format!("{from} {kind} {to}"), "linkType": kind, "linkSource": source, "originSlug": origin }),
    );
    store.add_link(from, to, &options).unwrap();
}

fn links(store: &Store, slug: &str, outgoing: bool) -> Vec<String> {
    let scope = LinkScope {
        source_id: Some("default".into()),
        ..LinkScope::default()
    };
    let rows = if outgoing {
        store.get_links(slug, &scope)
    } else {
        store.get_backlinks(slug, &scope)
    }
    .unwrap();
    let mut out: Vec<String> = rows
        .iter()
        .map(|l| {
            format!(
                "{} > {} {} origin={}",
                l["from_slug"].as_str().unwrap(),
                l["to_slug"].as_str().unwrap(),
                l["link_type"].as_str().unwrap(),
                l["origin_slug"].as_str().unwrap_or("-")
            )
        })
        .collect();
    out.sort();
    out
}

fn ids(twin: u64, survivor: u64) -> TwinMergeIds {
    TwinMergeIds {
        twin_id: twin as i64,
        survivor_id: survivor as i64,
    }
}

fn children(
    twin: u64,
    survivor: u64,
    twin_slug: &str,
    survivor_slug: &str,
) -> TwinPageChildrenMove {
    TwinPageChildrenMove {
        twin_id: twin as i64,
        survivor_id: survivor as i64,
        source_id: "default".into(),
        twin_slug: twin_slug.into(),
        survivor_slug: survivor_slug.into(),
    }
}

fn timeline(store: &Store, slug: &str) -> Vec<String> {
    let mut rows: Vec<String> = store
        .get_timeline(
            slug,
            &TimelineOptions {
                limit: Some(100),
                source_id: Some("default".into()),
                ..TimelineOptions::default()
            },
        )
        .unwrap()
        .iter()
        .map(|e| {
            format!(
                "{} {} {} event={}",
                e["date"].as_str().unwrap(),
                e["source"].as_str().unwrap(),
                e["summary"].as_str().unwrap(),
                e["event_page_id"]
            )
        })
        .collect();
    rows.sort();
    rows
}

#[test]
fn relationships_move_keep_their_indexes_and_drop_the_colliding_rows() {
    let (_dir, store) = brain("twin-relationships");
    let (twin, survivor) = (put(&store, "notes/twin"), put(&store, "notes/survivor"));
    let (alice, bob) = (put(&store, "people/alice"), put(&store, "people/bob"));
    link(
        &store,
        "notes/twin",
        "people/alice",
        "mentions",
        "markdown",
        None,
    );
    link(
        &store,
        "notes/survivor",
        "people/alice",
        "mentions",
        "markdown",
        None,
    );
    link(
        &store,
        "people/alice",
        "notes/twin",
        "works_at",
        "frontmatter",
        Some("people/alice"),
    );
    link(
        &store,
        "people/bob",
        "people/alice",
        "cites",
        "frontmatter",
        Some("notes/twin"),
    );
    link(
        &store,
        "notes/twin",
        "notes/survivor",
        "see_also",
        "manual",
        None,
    );
    link(
        &store,
        "notes/twin",
        "people/bob",
        "works_with",
        "frontmatter",
        Some("notes/twin"),
    );
    link(
        &store,
        "notes/survivor",
        "people/bob",
        "works_with",
        "frontmatter",
        Some("notes/survivor"),
    );
    let rel = |from: &str, to: &str, kind: &str, rows: Value| -> ManualWriteInput {
        args(
            json!({ "rel": { "from": from, "to": to, "linkType": kind, "sourceId": "default" }, "rows": rows }),
        )
    };
    for input in [
        rel(
            "notes/twin",
            "people/alice",
            "mentions",
            json!([{ "kind": "start", "occurred_on": "2020-01-01" }, { "kind": "end", "occurred_on": "2021-01-01" }]),
        ),
        rel(
            "notes/survivor",
            "people/alice",
            "mentions",
            json!([{ "kind": "start", "occurred_on": "2020-01-01" }]),
        ),
        rel(
            "people/alice",
            "notes/twin",
            "works_at",
            json!([{ "kind": "start", "occurred_on": "2019-05-05" }]),
        ),
    ] {
        store.write_manual_link_transitions(&input).unwrap();
    }

    let moved = store.move_twin_relationships(&ids(twin, survivor)).unwrap();
    assert_eq!(moved.deduplicated, 3);
    assert_eq!(moved.transitions_moved, 2);
    assert_eq!(moved.links_moved.len(), 2);
    assert!(moved.links_moved.windows(2).all(|w| w[0] < w[1]));
    let key = |from: u64, to: u64, kind: &str| format!("{from} {to} {kind}");
    let names = |keys: &[RelationshipKey]| -> Vec<String> {
        keys.iter()
            .map(|k| key(k.from_page_id, k.to_page_id, &k.link_type))
            .collect()
    };
    // The twin's keys before: its links (distinct, in key order), then its link transitions' keys.
    assert_eq!(
        names(&moved.before),
        [
            key(twin, survivor, "see_also"),
            key(twin, alice, "mentions"),
            key(twin, bob, "works_with"),
            key(alice, twin, "works_at"),
            key(twin, alice, "mentions"),
            key(alice, twin, "works_at"),
        ]
    );
    // The survivor's keys after: its links, then its transitions' keys (the pair link stays on the twin).
    assert_eq!(
        names(&moved.after),
        [
            key(twin, survivor, "see_also"),
            key(survivor, alice, "mentions"),
            key(survivor, bob, "works_with"),
            key(alice, survivor, "works_at"),
            key(survivor, alice, "mentions"),
            key(alice, survivor, "works_at"),
        ]
    );
    assert_eq!(
        links(&store, "notes/survivor", true),
        [
            "notes/survivor > people/alice mentions origin=-",
            "notes/survivor > people/bob works_with origin=notes/survivor"
        ]
    );
    assert_eq!(
        links(&store, "notes/twin", true),
        ["notes/twin > notes/survivor see_also origin=-"]
    );
    assert_eq!(
        links(&store, "people/alice", true),
        ["people/alice > notes/survivor works_at origin=people/alice"]
    );
    assert_eq!(
        links(&store, "people/bob", true),
        ["people/bob > people/alice cites origin=notes/survivor"]
    );
    // The indexes follow: backlinks of the survivor, and a later add of a moved relationship updates it in place.
    assert_eq!(
        links(&store, "notes/survivor", false),
        [
            "notes/twin > notes/survivor see_also origin=-",
            "people/alice > notes/survivor works_at origin=people/alice"
        ]
    );
    link(
        &store,
        "notes/survivor",
        "people/alice",
        "mentions",
        "markdown",
        None,
    );
    assert_eq!(links(&store, "notes/survivor", true).len(), 2);
    // A second run finds nothing to move.
    let again = store.move_twin_relationships(&ids(twin, survivor)).unwrap();
    assert_eq!(
        (
            again.links_moved.len(),
            again.transitions_moved,
            again.deduplicated
        ),
        (0, 0, 0)
    );
}

#[test]
fn page_children_move_unless_the_survivor_holds_the_same_and_the_indexes_follow() {
    let (_dir, store) = brain("twin-children");
    let (twin, survivor) = (put(&store, "notes/twin"), put(&store, "notes/survivor"));
    put(&store, "people/alice");
    put(&store, "people/bob");
    put(&store, "events/launch");
    let entry = |date: &str, source: &str, summary: &str| -> TimelineInput {
        args(json!({ "date": date, "source": source, "summary": summary, "detail": "d" }))
    };
    let sid = AddTimelineOptions {
        source_id: Some("default".into()),
        ..AddTimelineOptions::default()
    };
    for (slug, e) in [
        ("notes/twin", entry("2024-01-01", "meeting", "Kickoff")),
        ("notes/survivor", entry("2024-01-01", "meeting", "Kickoff")),
        ("notes/twin", entry("2024-02-02", "note", "Only on twin")),
    ] {
        assert!(store.add_timeline_entry(slug, &e, &sid).unwrap());
    }
    let project = |depth: &str, event: &str, date: &str| {
        let input: EventProjectionInput = args(
            json!({ "depthSlug": depth, "eventSlug": event, "date": date, "summary": format!("{depth} at {event}"), "sourceId": "default" }),
        );
        assert_eq!(
            store.upsert_event_projection(&input).unwrap()["projected"],
            true
        );
    };
    project("notes/twin", "events/launch", "2024-03-03");
    project("people/alice", "notes/twin", "2024-04-04");
    project("people/bob", "notes/survivor", "2024-04-04");
    project("people/bob", "notes/twin", "2024-05-05");
    store
        .put_raw_data(
            "notes/twin",
            Some("shared"),
            Some("{\"n\":1}"),
            Some("default"),
        )
        .unwrap();
    store
        .put_raw_data(
            "notes/survivor",
            Some("shared"),
            Some("{\"n\":1}"),
            Some("default"),
        )
        .unwrap();
    store
        .put_raw_data(
            "notes/twin",
            Some("only-twin"),
            Some("{\"n\":2}"),
            Some("default"),
        )
        .unwrap();
    for tag in ["added-only", "both"] {
        store.add_tag("notes/twin", tag, Some("default")).unwrap();
    }
    store
        .add_tag_claimed("notes/twin", "fm-twin", Some("default"), true)
        .unwrap();
    store
        .add_tag_claimed("notes/survivor", "both", Some("default"), true)
        .unwrap();
    let file = |path: &str, slug: &str, id: u64| {
        args(
            json!({ "source_id": "default", "page_slug": slug, "page_id": id, "filename": path, "storage_path": format!("default/{path}"), "content_hash": "h", "metadata": "{}" }),
        )
    };
    store
        .upsert_file(&file("twin.png", "notes/twin", twin))
        .unwrap();
    store
        .set_page_aliases(
            "notes/twin",
            "default",
            &["launch".to_string(), "shared".to_string()],
        )
        .unwrap();
    store
        .set_page_aliases("notes/survivor", "default", &["shared".to_string()])
        .unwrap();
    let (twin_before, survivor_before) = (
        snapshot(&store, "notes/twin"),
        snapshot(&store, "notes/survivor"),
    );

    let tags = store
        .move_twin_page_children(&children(twin, survivor, "notes/twin", "notes/survivor"))
        .unwrap();
    assert_eq!(tags, ["added-only"]);
    assert_eq!(timeline(&store, "notes/twin"), Vec::<String>::new());
    assert_eq!(timeline(&store, "notes/survivor").len(), 3);
    assert!(
        timeline(&store, "notes/survivor").contains(
            &"2024-03-03 life-chronicle:event:events/launch notes/twin at events/launch event=3"
                .replace(
                    "event=3",
                    &format!("event={}", store_page_id(&store, "events/launch"))
                )
        )
    );
    assert_eq!(timeline(&store, "people/alice"), Vec::<String>::new());
    assert_eq!(timeline(&store, "people/bob").len(), 2);
    assert!(
        timeline(&store, "people/bob")
            .iter()
            .all(|row| row.ends_with(&format!("event={survivor}")))
    );
    let raw = |slug: &str| {
        store
            .get_raw_data(slug, None, &Default::default())
            .unwrap()
            .iter()
            .map(|r| r["source"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(raw("notes/twin"), ["shared"]);
    assert_eq!(raw("notes/survivor"), ["only-twin", "shared"]);
    let mut twin_tags = store.get_tags("notes/twin", &ReadScope::default()).unwrap();
    twin_tags.sort();
    assert_eq!(twin_tags, ["both", "fm-twin"]);
    assert_eq!(store.list_files_for_page(&json!(twin)).unwrap().len(), 0);
    let attached = store.list_files_for_page(&json!(survivor)).unwrap();
    assert_eq!(
        (attached.len(), attached[0]["page_slug"].as_str()),
        (1, Some("notes/survivor"))
    );
    // Both pages' revisions advanced for the moved tag, and the claim moved the import-owned `both` to `added`.
    assert_ne!(
        snapshot(&store, "notes/twin")["knowledge_revision"],
        twin_before["knowledge_revision"]
    );
    assert_ne!(
        snapshot(&store, "notes/survivor")["knowledge_revision"],
        survivor_before["knowledge_revision"]
    );
    store
        .prune_frontmatter_tags("notes/survivor", &[], Some("default"))
        .unwrap();
    let mut kept = store
        .get_tags("notes/survivor", &ReadScope::default())
        .unwrap();
    kept.sort();
    assert_eq!(kept, ["added-only", "both"]);
    // The event index followed the move: projecting the same event date again updates the row, never a second one.
    project("people/bob", "notes/survivor", "2024-05-05");
    assert_eq!(timeline(&store, "people/bob").len(), 2);
    // A second run moves nothing, and no tag moves.
    assert!(
        store
            .move_twin_page_children(&children(twin, survivor, "notes/twin", "notes/survivor"))
            .unwrap()
            .is_empty()
    );
}

fn store_page_id(store: &Store, slug: &str) -> u64 {
    snapshot(store, slug)["id"].as_u64().unwrap()
}

#[test]
fn facts_about_the_twin_rekey_and_its_own_fence_rows_stay() {
    let (_dir, store) = brain("twin-facts");
    put(&store, "notes/twin");
    put(&store, "notes/survivor");
    let rows = json!([
        { "fact": "from another page", "entity_slug": "notes/twin", "source_markdown_slug": "notes/other", "row_num": 1, "kind": "fact", "visibility": "private", "source": "mcp:extract_facts" },
        { "fact": "its own fence row", "entity_slug": "notes/twin", "source_markdown_slug": "notes/twin", "row_num": 1, "kind": "fact", "visibility": "private", "source": "mcp:extract_facts" },
        { "fact": "from no page", "entity_slug": "notes/twin", "kind": "fact", "visibility": "private", "source": "mcp:extract_facts" },
    ]);
    let inserted = store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": "default" }),
        ))
        .unwrap();
    let fact_ids: Vec<u64> = inserted["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i.as_u64().unwrap())
        .collect();
    let about = |entity: &str| -> Vec<String> {
        let query: FactQuery =
            args(json!({ "sourceId": "default", "entitySlug": entity, "limit": 100 }));
        let mut facts: Vec<String> = store
            .list_facts_by_entity(&query)
            .unwrap()
            .iter()
            .map(|f| f["fact"].as_str().unwrap().to_string())
            .collect();
        facts.sort();
        facts
    };
    let moved = store
        .move_twin_facts("default", "notes/twin", "notes/survivor")
        .unwrap();
    assert_eq!(moved, [fact_ids[0], fact_ids[2]]);
    assert_eq!(about("notes/twin"), ["its own fence row"]);
    assert_eq!(
        about("notes/survivor"),
        ["from another page", "from no page"]
    );
    assert!(
        store
            .move_twin_facts("default", "notes/twin", "notes/survivor")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn refusals_name_the_problem_and_write_nothing() {
    let (_dir, store) = brain("twin-refusals");
    let (twin, survivor) = (put(&store, "notes/twin"), put(&store, "notes/survivor"));
    put(&store, "people/alice");
    link(
        &store,
        "notes/twin",
        "people/alice",
        "mentions",
        "markdown",
        None,
    );
    store
        .put_raw_data("notes/twin", Some("only-twin"), Some("{}"), Some("default"))
        .unwrap();
    store.add_tag("notes/twin", "t", Some("default")).unwrap();
    // One page is not its own twin.
    assert_eq!(
        store
            .move_twin_relationships(&ids(twin, twin))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store
            .move_twin_page_children(&children(twin, twin, "notes/twin", "notes/twin"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    // A survivor that does not exist refuses as the foreign key does, and the twin keeps every row.
    let missing = 987_654_u64;
    assert_eq!(
        store
            .move_twin_relationships(&ids(twin, missing))
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        store
            .move_twin_page_children(&children(twin, missing, "notes/twin", "notes/gone"))
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        links(&store, "notes/twin", true),
        ["notes/twin > people/alice mentions origin=-"]
    );
    assert_eq!(
        store
            .get_raw_data("notes/twin", None, &Default::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.get_tags("notes/twin", &ReadScope::default()).unwrap(),
        ["t"]
    );
    // A negative page id names no page: nothing moves.
    let none = store
        .move_twin_relationships(&TwinMergeIds {
            twin_id: -1,
            survivor_id: survivor as i64,
        })
        .unwrap();
    assert_eq!((none.before.len(), none.links_moved.len()), (0, 0));
    // Text a key cannot hold is refused before anything is written.
    assert_eq!(
        store
            .move_twin_facts("default", "notes/\0twin", "notes/survivor")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_transition_the_survivor_already_has_is_dropped_and_the_rest_move_in_one_write() {
    let (_dir, store) = brain("twin-transitions");
    let (twin, survivor) = (put(&store, "notes/twin"), put(&store, "notes/survivor"));
    put(&store, "people/alice");
    let rel = |from: &str, rows: Value| -> ManualWriteInput {
        args(
            json!({ "rel": { "from": from, "to": "people/alice", "linkType": "mentions", "sourceId": "default" }, "rows": rows }),
        )
    };
    store.write_manual_link_transitions(&rel("notes/twin", json!([{ "kind": "start", "occurred_on": "2020-01-01" }, { "kind": "end", "occurred_on": "2021-01-01" }]))).unwrap();
    store
        .write_manual_link_transitions(&rel(
            "notes/survivor",
            json!([{ "kind": "start", "occurred_on": "2020-01-01" }]),
        ))
        .unwrap();
    let moved = store.move_twin_relationships(&ids(twin, survivor)).unwrap();
    assert_eq!(
        (
            moved.transitions_moved,
            moved.deduplicated,
            moved.links_moved.len()
        ),
        (1, 1, 0)
    );
    let rows = store
        .list_manual_link_transitions("default", "notes/survivor")
        .unwrap();
    assert_eq!(rows.as_array().map(Vec::len), Some(2));
    assert_eq!(
        store
            .list_manual_link_transitions("default", "notes/twin")
            .unwrap()
            .as_array()
            .map(Vec::len),
        Some(0)
    );
}
