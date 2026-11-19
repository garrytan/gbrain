//! The group 5 repair reads the store serves (`facts/repair.rs`): the two session-fact classifier reads, the
//! captured-fact classifier read and the world-facts-from-private-sources read.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::repair::{ClassifyArgs, TwinArgs, WorldFactArgs};
use gbrain_store::facts::{ExpireFactArgs, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU32, Ordering};

const LANE: &str = "hook:agent-session";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    let other: SourceInput =
        serde_json::from_value(json!({ "id": "other", "name": "other", "config": {} })).unwrap();
    store.upsert_source(&other).unwrap();
    (dir, store)
}

fn put(store: &Store, slug: &str, page_type: &str, frontmatter: Value, source: &str) {
    let input: PageInput = serde_json::from_value(json!({
        "type": page_type, "title": slug, "compiled_truth": slug, "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

/// One fact; `extra` overrides the defaults. Returns its id.
fn fact(store: &Store, source_id: &str, text: &str, extra: Value) -> u64 {
    let mut input = json!({
        "fact": text, "visibility": "private", "source": LANE, "valid_from": "2026-01-01T00:00:00.000Z",
    });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    // `insertFacts` keeps `row_num` and `source_markdown_slug`; the single insert does not.
    if input.get("source_markdown_slug").is_some() && input.get("row_num").is_none() {
        input["row_num"] = json!(store_next_row());
    }
    store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [input], "sourceId": source_id }),
        ))
        .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

fn store_next_row() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(100);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn ids(rows: &[Value]) -> Vec<u64> {
    rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
}

fn classify(source_ids: &[&str], lanes: &[&str], ids: Option<&[i64]>) -> ClassifyArgs {
    args(json!({ "sourceIds": source_ids, "lanes": lanes, "ids": ids }))
}

#[test]
fn session_facts_are_the_active_user_or_unset_lane_facts_by_source_then_id() {
    let (_dir, store) = brain("repair-session");
    let a = fact(
        &store,
        "default",
        "alpha",
        json!({ "source_session": "s1", "context": "ctx", "entity_slug": "people/a", "row_num": 3, "source_markdown_slug": "n/a" }),
    );
    let b = fact(
        &store,
        "default",
        "bravo",
        json!({ "attributed_to": "assistant" }),
    );
    let c = fact(
        &store,
        "default",
        "charlie",
        json!({ "attributed_to": "user" }),
    );
    let _d = fact(
        &store,
        "default",
        "delta",
        json!({ "source": "mcp:remember" }),
    );
    let e = fact(&store, "other", "echo", json!({}));
    let f = fact(&store, "default", "foxtrot", json!({}));
    assert!(
        store
            .expire_fact(&args::<ExpireFactArgs>(json!({ "id": f })))
            .unwrap()
    );
    let g = fact(&store, "default", "golf", json!({}));
    let g2 = fact(&store, "default", "golf two", json!({}));
    assert!(
        store
            .expire_fact(&args::<ExpireFactArgs>(
                json!({ "id": g, "supersededBy": g2 })
            ))
            .unwrap()
    );
    let _ = b;

    let rows = store
        .list_session_facts_for_classification(&classify(&["other", "default"], &[LANE], None))
        .unwrap();
    // `default` sorts before `other`; inside a source, by id. The assistant row, the other lane, the expired row
    // and the superseded row are left out.
    assert_eq!(ids(&rows), vec![a, c, g2, e]);
    assert_eq!(rows[0]["source_session"], json!("s1"));
    assert_eq!(rows[0]["context"], json!("ctx"));
    assert_eq!(rows[0]["entity_slug"], json!("people/a"));
    assert_eq!(rows[0]["row_num"], json!(3));
    assert_eq!(rows[0]["source_markdown_slug"], json!("n/a"));
    assert_eq!(rows[0]["attributed_to"], Value::Null);
    assert_eq!(rows[1]["attributed_to"], json!("user"));
    assert_eq!(rows[3]["source_id"], json!("other"));

    let named = store
        .list_session_facts_for_classification(&classify(
            &["default", "other"],
            &[LANE],
            Some(&[e as i64, a as i64, 9999]),
        ))
        .unwrap();
    assert_eq!(ids(&named), vec![a, e]);
    let none = store
        .list_session_facts_for_classification(&classify(&["default"], &[LANE], Some(&[])))
        .unwrap();
    assert!(none.is_empty());
    let no_lane = store
        .list_session_facts_for_classification(&classify(&["default"], &[], None))
        .unwrap();
    assert!(no_lane.is_empty());
}

#[test]
fn session_fact_twins_name_the_owner_twin_and_the_lane_sessions() {
    let (_dir, store) = brain("repair-twins");
    let lane = |text: &str, session: Option<&str>, extra: Value| {
        let mut x = json!({ "entity_slug": "people/a" });
        if let Some(s) = session {
            x["source_session"] = json!(s);
        }
        for (k, v) in extra.as_object().unwrap() {
            x[k] = v.clone();
        }
        fact(&store, "default", text, x)
    };
    let a = lane("Alice moved to Paris", Some("s2"), json!({}));
    let b = lane("alice  MOVED to paris", Some("s1"), json!({}));
    let c = lane("Alice moved to Paris", None, json!({}));
    let _d = lane(
        "Alice moved to Paris",
        Some("s1"),
        json!({ "attributed_to": "assistant" }),
    );
    let expired = lane("Alice moved to Paris", Some("s9"), json!({}));
    assert!(
        store
            .expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired })))
            .unwrap()
    );
    let f = fact(
        &store,
        "default",
        "Alice moved to Paris",
        json!({ "source": "mcp:remember", "entity_slug": "people/a", "visibility": "world" }),
    );
    let _other_entity = fact(
        &store,
        "default",
        "Bob only",
        json!({ "source": "mcp:remember" }),
    );
    let lone = lane("Only one", Some("s3"), json!({}));
    let _elsewhere = fact(
        &store,
        "other",
        "Only one",
        json!({ "entity_slug": "people/a", "source_session": "s7" }),
    );

    let rows = store
        .list_session_fact_twins(&args::<TwinArgs>(
            json!({ "ids": [lone, c, a, a, 99999, -4], "lanes": [LANE] }),
        ))
        .unwrap();
    // By id; an id with no fact answers nothing.
    assert_eq!(ids(&rows), vec![a, c, lone]);
    // `a` has the owner twin `f` and capture-lane twins b (s1) and c (no session: the empty text).
    assert_eq!(rows[0]["owner_twin"], json!(true));
    assert_eq!(rows[0]["twin_sessions"], json!(["", "s1"]));
    assert_eq!(rows[1]["owner_twin"], json!(true));
    assert_eq!(rows[1]["twin_sessions"], json!(["s1", "s2"]));
    assert_eq!(rows[2]["owner_twin"], json!(false));
    assert_eq!(rows[2]["twin_sessions"], json!([]));
    let _ = (b, f);

    let no_lane = store
        .list_session_fact_twins(&args::<TwinArgs>(json!({ "ids": [a], "lanes": [] })))
        .unwrap();
    // No lane: every twin is an owner twin and none is a capture-lane twin.
    assert_eq!(no_lane[0]["owner_twin"], json!(true));
    assert_eq!(no_lane[0]["twin_sessions"], json!([]));
    assert!(
        store
            .list_session_fact_twins(&args::<TwinArgs>(json!({ "ids": [], "lanes": [LANE] })))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn captured_facts_carry_their_fingerprint_and_whether_a_legitimate_twin_exists() {
    let (_dir, store) = brain("repair-captured");
    let ent = json!({ "entity_slug": "people/a" });
    let a = fact(&store, "default", "Alice moved to Paris", ent.clone());
    let owner = fact(
        &store,
        "default",
        "alice MOVED to paris",
        json!({ "source": "mcp:remember", "entity_slug": "people/a" }),
    );
    let b = fact(
        &store,
        "default",
        "Bob likes tea",
        json!({ "entity_slug": "people/b" }),
    );
    // A twin with another visibility is not legitimate; neither is one of another entity or one that expired.
    let _w = fact(
        &store,
        "default",
        "Bob likes tea",
        json!({ "source": "mcp:remember", "visibility": "world", "entity_slug": "people/b" }),
    );
    let c = fact(
        &store,
        "default",
        "Carol likes jam",
        json!({ "entity_slug": "people/c" }),
    );
    let _x = fact(
        &store,
        "default",
        "Carol likes jam",
        json!({ "source": "mcp:remember", "entity_slug": "people/other" }),
    );
    let d = fact(&store, "default", "Dan likes figs", json!({}));
    let dx = fact(
        &store,
        "default",
        "Dan likes figs",
        json!({ "source": "mcp:remember" }),
    );
    assert!(
        store
            .expire_fact(&args::<ExpireFactArgs>(json!({ "id": dx })))
            .unwrap()
    );
    // Superseding a twin closes it, so it no longer counts.
    let e = fact(&store, "default", "Eve likes nuts", json!({}));
    let e_old = fact(
        &store,
        "default",
        "Eve likes nuts",
        json!({ "source": "mcp:remember" }),
    );
    let e_new = fact(
        &store,
        "default",
        "Eve likes more nuts",
        json!({ "source": "mcp:remember" }),
    );
    assert!(
        store
            .expire_fact(&args::<ExpireFactArgs>(
                json!({ "id": e_old, "supersededBy": e_new })
            ))
            .unwrap()
    );
    let _ = owner;

    let rows = store
        .list_captured_facts_for_classification(&classify(&["default"], &[LANE], None))
        .unwrap();
    assert_eq!(ids(&rows), vec![a, b, c, d, e]);
    let twin: Vec<bool> = rows
        .iter()
        .map(|r| r["legit_twin"].as_bool().unwrap())
        .collect();
    assert_eq!(twin, vec![true, false, false, false, false]);
    assert_eq!(rows[0]["source"], json!(LANE));
    assert_eq!(rows[0]["fingerprint"].as_str().unwrap().len(), 64);
    assert_eq!(
        rows[0]["fingerprint"],
        json!(store_fingerprint(&store, owner))
    );
    let named = store
        .list_captured_facts_for_classification(&classify(&["default"], &[LANE], Some(&[c as i64])))
        .unwrap();
    assert_eq!(ids(&named), vec![c]);
}

/// The fingerprint a stored fact reports, read through the captured-facts read of its own lane.
fn store_fingerprint(store: &Store, id: u64) -> String {
    let rows = store
        .list_captured_facts_for_classification(&classify(
            &["default"],
            &["mcp:remember"],
            Some(&[id as i64]),
        ))
        .unwrap();
    rows[0]["fingerprint"].as_str().unwrap().to_string()
}

fn world(
    store: &Store,
    source_ids: &[&str],
    ids: Option<&[i64]>,
    honor_aliases: bool,
) -> Vec<Value> {
    store
        .list_world_facts_from_private_sources(&args::<WorldFactArgs>(
            json!({ "sourceIds": source_ids, "ids": ids, "honorAliases": honor_aliases }),
        ))
        .unwrap()
}

#[test]
fn world_facts_from_private_sources_follow_the_holding_and_provenance_pages() {
    let (_dir, store) = brain("repair-world");
    put(&store, "notes/open", "note", json!({}), "default");
    put(
        &store,
        "notes/private",
        "note",
        json!({ "visibility": "private" }),
        "default",
    );
    put(
        &store,
        "notes/alias",
        "note",
        json!({ "access": " Confidential " }),
        "default",
    );
    put(
        &store,
        "notes/readers",
        "note",
        json!({ "readable_by": ["x"] }),
        "default",
    );
    put(&store, "notes/derived", "atom", json!({}), "default");
    put(
        &store,
        "notes/pinned",
        "note",
        json!({ "pinned_question": true }),
        "default",
    );
    put(
        &store,
        "notes/gone",
        "note",
        json!({ "visibility": "private" }),
        "default",
    );
    put(
        &store,
        "notes/elsewhere",
        "note",
        json!({ "visibility": "private" }),
        "other",
    );
    store.soft_delete_page("notes/gone", None).unwrap();
    let world_fact = |text: &str, extra: Value| {
        let mut x = json!({ "visibility": "world", "source": "fence" });
        for (k, v) in extra.as_object().unwrap() {
            x[k] = v.clone();
        }
        fact(&store, "default", text, x)
    };
    let open = world_fact(
        "held by an open page",
        json!({ "source_markdown_slug": "notes/open" }),
    );
    let private = world_fact(
        "held by a private page",
        json!({ "source_markdown_slug": "notes/private", "entity_slug": "people/a", "row_num": 2 }),
    );
    let alias = world_fact(
        "held by an alias page",
        json!({ "source_markdown_slug": "notes/alias" }),
    );
    let readers = world_fact(
        "held by a readers page",
        json!({ "source_markdown_slug": "notes/readers" }),
    );
    let derived = world_fact(
        "held by a derived page",
        json!({ "source_markdown_slug": "notes/derived" }),
    );
    let pinned = world_fact(
        "held by a pinned page",
        json!({ "source_markdown_slug": "notes/pinned" }),
    );
    let gone = world_fact(
        "held by a deleted page",
        json!({ "source_markdown_slug": "notes/gone" }),
    );
    let missing = world_fact(
        "held by no page",
        json!({ "source_markdown_slug": "notes/missing" }),
    );
    // Extracted from a private page: named by the session, or by the first word of the context.
    let by_session = world_fact(
        "named by session",
        json!({ "source": "mcp:put_page", "source_session": "put_page:notes/private.md" }),
    );
    let by_context = world_fact(
        "named by context",
        json!({ "source": "sync:import", "context": " notes/private.md rest of it " }),
    );
    let by_context_alias = world_fact(
        "named by context 2",
        json!({ "source": "code_import", "context": "notes/alias" }),
    );
    let wrong_source = world_fact(
        "a source that names no page",
        json!({ "source": "cli", "context": "notes/private" }),
    );
    let empty_session = world_fact(
        "named by an empty session",
        json!({ "source": "mcp:put_page", "source_session": "sync:", "context": "notes/private" }),
    );
    let other_source_page = world_fact(
        "page lives in another source",
        json!({ "source": "mcp:put_page", "context": "notes/elsewhere" }),
    );
    let not_world = fact(
        &store,
        "default",
        "private fact",
        json!({ "visibility": "private", "source_markdown_slug": "notes/private" }),
    );
    let expired = world_fact(
        "expired",
        json!({ "source_markdown_slug": "notes/private" }),
    );
    assert!(
        store
            .expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired })))
            .unwrap()
    );
    let _ = (
        open,
        missing,
        wrong_source,
        empty_session,
        other_source_page,
        not_world,
        gone,
        pinned,
    );

    let on = world(&store, &["default"], None, true);
    let on_ids = ids(&on);
    assert_eq!(
        on_ids,
        vec![
            private,
            alias,
            readers,
            derived,
            pinned,
            by_session,
            by_context,
            by_context_alias
        ]
    );
    let readable = |rows: &[Value], id: u64| {
        rows.iter().find(|r| r["id"].as_u64() == Some(id)).unwrap()["readable"]
            .as_bool()
            .unwrap()
    };
    // A private page, a derived page with no visibility and a pinned page are not readable; `readable_by` alone is.
    assert!(!readable(&on, private));
    assert!(readable(&on, readers));
    assert!(!readable(&on, derived));
    assert!(!readable(&on, pinned));
    // An alias page is unreadable only while aliases are honoured; the fact extracted from it names its page, which is
    // not its holder, so it is readable.
    assert!(!readable(&on, alias));
    assert!(readable(&on, by_session));
    assert!(readable(&on, by_context_alias));
    let first = &on[0];
    assert_eq!(first["source_id"], json!("default"));
    assert_eq!(first["entity_slug"], json!("people/a"));
    assert_eq!(first["row_num"], json!(2));
    assert_eq!(first["source_markdown_slug"], json!("notes/private"));

    let off = world(&store, &["default"], None, false);
    assert_eq!(ids(&off), on_ids);
    assert!(readable(&off, alias));
    assert!(!readable(&off, private));

    assert_eq!(
        ids(&world(
            &store,
            &["default"],
            Some(&[readers as i64, alias as i64, open as i64]),
            true
        )),
        vec![alias, readers]
    );
    assert!(world(&store, &["default"], Some(&[]), true).is_empty());
    assert!(world(&store, &[], None, true).is_empty());
    assert!(world(&store, &["other"], None, true).is_empty());
}

fn label_page(store: &Store, slug: &str, body: &str, timeline: &str) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": body, "timeline": timeline, "frontmatter": {},
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

#[test]
fn label_facts_count_the_uncovered_segment_facts_of_pages_with_a_label_line() {
    let (_d, store) = brain("label-facts");
    label_page(&store, "chats/body", "intro\n**DATE :** today", "");
    label_page(&store, "chats/timeline", "none", "- entry\n**Notes:** x");
    label_page(&store, "chats/mid", "see **Date:** inline", "");
    label_page(&store, "chats/audited", "**Date:** done", "");
    let seg = "cli:extract-conversation-facts";
    let ctx = "segment 1970-01-01 x";
    let label = |slug: &str, text: &str, extra: Value| {
        let mut row = json!({ "source": seg, "source_markdown_slug": slug, "context": ctx });
        for (k, v) in extra.as_object().unwrap() {
            row[k] = v.clone();
        }
        fact(&store, "default", text, row)
    };
    label("chats/body", "counted", json!({}));
    label("chats/timeline", "counted too", json!({}));
    label("chats/mid", "mid-line label", json!({}));
    label("chats/audited", "decided page", json!({}));
    label(
        "chats/body",
        "other context",
        json!({ "context": "segment 2020" }),
    );
    label(
        "chats/body",
        "withdrawn",
        json!({ "entity_slug": "people/a" }),
    );
    fact(
        &store,
        "default",
        "audit",
        json!({ "source": "audit:t", "source_markdown_slug": "chats/audited", "context": "extractor_version=2" }),
    );
    assert!(
        store
            .insert_fact_withdrawal("default", "private", "withdrawn", "people/a", None)
            .unwrap()
    );
    let count = |limit: u64, sources: &[&str]| {
        store
            .count_label_facts(&args(json!({
                "sourceIds": sources, "limit": limit, "segmentSource": seg, "contextContains": "segment 1970-01-01",
                "labels": ["date", "note", "notes"], "terminalSource": "audit:t", "nonExtractableSource": "audit:n",
            })))
            .unwrap()
    };
    assert_eq!(count(100, &["default"]), 2);
    assert_eq!(count(1, &["default"]), 1);
    assert_eq!(count(0, &["default"]), 0);
    assert_eq!(count(100, &["other"]), 0);
    assert_eq!(count(100, &[]), 0);
}

#[test]
fn purged_page_facts_are_the_uncovered_gone_page_facts_and_an_empty_ledger_leaves_each_ambiguous() {
    let (_d, store) = brain("purged-page-facts");
    put(&store, "notes/live", "note", json!({}), "default");
    let gone = |source: &str, text: &str, context: Option<&str>, extra: Value| {
        let mut row = json!({ "source": "mcp:put_page", "context": context });
        for (k, v) in extra.as_object().unwrap() {
            row[k] = v.clone();
        }
        fact(&store, source, text, row)
    };
    gone(
        "default",
        "counted",
        Some("notes/gone \u{2014} a"),
        json!({}),
    );
    gone(
        "default",
        "counted too",
        Some("code/x.ts"),
        json!({ "source": "code_import" }),
    );
    gone("other", "other source", Some("notes/gone"), json!({}));
    gone("default", "no slash", Some("gone \u{2014} a"), json!({}));
    gone("default", "space", Some("notes/a\u{2003}b"), json!({}));
    gone("default", "live page", Some("notes/live"), json!({}));
    gone("default", "no context", None, json!({}));
    gone(
        "default",
        "lane",
        Some("notes/gone"),
        json!({ "source": LANE }),
    );
    gone(
        "default",
        "filed",
        Some("notes/gone"),
        json!({ "source_markdown_slug": "notes/gone" }),
    );
    gone(
        "default",
        "withdrawn",
        Some("notes/gone"),
        json!({ "entity_slug": "people/a" }),
    );
    assert!(
        store
            .insert_fact_withdrawal("default", "private", "withdrawn", "people/a", None)
            .unwrap()
    );
    let count = |limit: u64, sources: &[&str]| {
        store
            .count_purged_page_facts(&args(json!({ "sourceIds": sources, "limit": limit })))
            .unwrap()
    };
    assert_eq!(count(100, &["default"]), vec![false, false]);
    assert_eq!(count(1, &["default"]), vec![false]);
    assert!(count(0, &["default"]).is_empty());
    assert_eq!(
        count(100, &["other", "default", "other"]),
        vec![false, false, false]
    );
    assert!(count(100, &[]).is_empty());
}
