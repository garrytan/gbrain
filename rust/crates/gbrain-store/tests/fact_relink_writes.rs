//! The guarded relink writes of `facts` rows (`facts/relink_writes.rs`): the PGLite semantics of
//! `placeRelinkedFact` and `linkConversationFact`, and of `listConversationRelinkPages`, the
//! conversation relink's page pick.

mod memory_env;

use gbrain_store::facts::cycle::PageCoordinate;
use gbrain_store::facts::relink::{AttemptInput, UpsertOptions};
use gbrain_store::facts::relink_writes::{
    ConversationFactLink, ConversationRelinkPagesQuery, RelinkPlacement,
};
use gbrain_store::facts::{ExpireFactArgs, FactQuery, InsertFactArgs, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const CONVERSATION: &str = "cli:extract-conversation-facts";
const TERMINAL: &str = "cli:extract-conversation-facts:terminal:v2";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(b: &Brain, id: &str) {
    b.upsert_source(&args::<SourceInput>(json!({ "id": id, "name": id })))
        .unwrap();
}

fn page(b: &Brain, source_id: &str, slug: &str) {
    let input: PageInput =
        args(json!({ "type": "person", "title": slug, "compiled_truth": "body" }));
    let options: PutPageOptions = args(json!({ "sourceId": source_id }));
    b.put_page(slug, &input, &options).unwrap();
}

/// An unplaced row (no entity, page or row number).
fn loose(b: &Brain, source_id: &str, claim: &str) -> u64 {
    b.insert_fact(&args::<InsertFactArgs>(json!({
        "input": { "fact": claim, "source": "chat" }, "sourceId": source_id,
    })))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

/// A conversation page's derived row, database-only (no row number).
fn derived(b: &Brain, source_id: &str, slug: &str, input: Value) -> u64 {
    let mut row = json!({ "fact": "met at the cafe", "source": CONVERSATION, "source_markdown_slug": slug, "row_num": null });
    for (k, v) in input.as_object().unwrap() {
        row[k] = v.clone();
    }
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": [row], "sourceId": source_id }),
    ))
    .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

/// The rows of `entity` in the source, as (id, context, expired).
fn on_entity(b: &Brain, source_id: &str, entity: &str) -> Vec<(u64, Value, bool)> {
    b.list_facts_by_entity(&args::<FactQuery>(json!({
        "sourceId": source_id, "entitySlug": entity, "limit": 100,
    })))
    .unwrap()
    .into_iter()
    .map(|r| {
        (
            r["id"].as_u64().unwrap(),
            r["context"].clone(),
            !r["expired_at"].is_null(),
        )
    })
    .collect()
}

fn place(b: &Brain, source_id: &str, v: Value) -> bool {
    b.place_relinked_fact(source_id, &args::<RelinkPlacement>(v))
        .unwrap()
}

fn link(b: &Brain, source_id: &str, v: Value) -> bool {
    b.link_conversation_fact(source_id, &args::<ConversationFactLink>(v))
        .unwrap()
}

#[test]
fn placing_links_or_retires_only_an_unplaced_row_of_the_source() {
    let b = brain("relink-place");
    source(&b, "s2");
    page(&b, "default", "people/alice-example");
    let linked = loose(&b, "default", "likes tea");
    let retired = loose(&b, "default", "likes coffee");
    let other = loose(&b, "s2", "likes cocoa");
    let gone = loose(&b, "default", "likes juice");
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone })))
        .unwrap();

    let at = |id: u64, action: &str| json!({ "factId": id, "action": action, "slug": "people/alice-example", "rowNum": 4, "context": "relinked" });
    assert!(place(&b, "default", at(linked, "link")));
    // A second placement of the same row finds it placed and leaves it.
    assert!(!place(&b, "default", at(linked, "link")));
    let mut retire = at(retired, "retire");
    retire.as_object_mut().unwrap().remove("rowNum");
    assert!(place(&b, "default", retire));
    // Another source's row, an expired row and a missing id do not move.
    assert!(!place(&b, "default", at(other, "link")));
    assert!(!place(&b, "default", at(gone, "retire")));
    assert!(!place(&b, "default", at(999_999, "link")));

    let mut rows = on_entity(&b, "default", "people/alice-example");
    rows.sort_by_key(|r| r.0);
    assert_eq!(
        rows,
        vec![
            (linked, json!("relinked"), false),
            (retired, json!("relinked"), true),
        ]
    );
    // Only the linked row took the page coordinate and its row number.
    let fenced: Vec<(u64, Value)> = b
        .list_facts_for_page(&args::<PageCoordinate>(json!({
            "sourceId": "default", "slug": "people/alice-example",
        })))
        .unwrap()
        .into_iter()
        .map(|r| (r["id"].as_u64().unwrap(), r["row_num"].clone()))
        .collect();
    assert_eq!(fenced, vec![(linked, json!(4))]);
}

#[test]
fn placing_onto_a_held_fence_position_refuses_as_the_unique_index_does() {
    let b = brain("relink-place-dup");
    page(&b, "default", "people/alice-example");
    let first = loose(&b, "default", "likes tea");
    let second = loose(&b, "default", "likes coffee");
    let at = |id: u64| json!({ "factId": id, "action": "link", "slug": "people/alice-example", "rowNum": 1, "context": "relinked" });
    assert!(place(&b, "default", at(first)));
    let err = b
        .place_relinked_fact("default", &args::<RelinkPlacement>(at(second)))
        .unwrap_err();
    assert_eq!(err.code, "constraint_violation", "{err:?}");
    assert!(err.message.contains("idx_facts_fence_key"), "{err:?}");
    // The refused write left the row unplaced.
    assert!(
        on_entity(&b, "default", "people/alice-example")
            .iter()
            .all(|r| r.0 != second)
    );
}

#[test]
fn a_placement_with_a_bad_row_number_or_action_is_invalid() {
    let b = brain("relink-place-args");
    let id = loose(&b, "default", "likes tea");
    for v in [
        json!({ "factId": id, "action": "link", "slug": "p", "rowNum": 1.5, "context": "c" }),
        json!({ "factId": id, "action": "link", "slug": "p", "rowNum": 3e9, "context": "c" }),
        json!({ "factId": id, "action": "link", "slug": "p", "context": "c" }),
        json!({ "factId": id, "action": "move", "slug": "p", "context": "c" }),
    ] {
        let err = b
            .place_relinked_fact("default", &args::<RelinkPlacement>(v.clone()))
            .unwrap_err();
        assert_eq!(err.code, "invalid_argument", "{v}: {err:?}");
    }
}

#[test]
fn a_conversation_row_links_only_while_it_is_still_as_planned() {
    let b = brain("relink-conversation");
    page(&b, "default", "people/alice-example");
    let slug = "conversations/2026-01-01";
    let plain = derived(&b, "default", slug, json!({}));
    let assistant = derived(&b, "default", slug, json!({ "attributed_to": "assistant" }));
    let audit = derived(&b, "default", slug, json!({ "source": TERMINAL }));
    let chat = derived(&b, "default", slug, json!({ "source": "chat" }));
    let named = derived(&b, "default", slug, json!({ "entity_slug": "alice" }));
    let backed = derived(
        &b,
        "default",
        slug,
        json!({ "entity_slug": "people/alice-example" }),
    );

    let to = |id: u64, entity: &str, from: Value| json!({ "factId": id, "pageSlug": slug, "fact": "met at the cafe", "entitySlug": entity, "context": "relinked", "from": from });
    // A changed claim, another page and a deleted target do not link.
    let mut claim = to(plain, "people/alice-example", Value::Null);
    claim["fact"] = json!("met at the bar");
    assert!(!link(&b, "default", claim));
    let mut other_page = to(plain, "people/alice-example", Value::Null);
    other_page["pageSlug"] = json!("conversations/other");
    assert!(!link(&b, "default", other_page));
    assert!(!link(
        &b,
        "default",
        to(plain, "people/missing", Value::Null)
    ));
    // An assistant-said row, an audit row and a non-conversation row never link.
    assert!(!link(
        &b,
        "default",
        to(assistant, "people/alice-example", Value::Null)
    ));
    assert!(!link(
        &b,
        "default",
        to(audit, "people/alice-example", Value::Null)
    ));
    assert!(!link(
        &b,
        "default",
        to(chat, "people/alice-example", Value::Null)
    ));
    // A row on a name key links only with that key as `from`; an empty `from` means no entity.
    assert!(!link(
        &b,
        "default",
        to(named, "people/alice-example", Value::Null)
    ));
    assert!(!link(
        &b,
        "default",
        to(named, "people/alice-example", json!(""))
    ));
    assert!(!link(
        &b,
        "default",
        to(named, "people/alice-example", json!("bob"))
    ));
    // A row on a page-backed slug is not unbacked.
    assert!(!link(
        &b,
        "default",
        to(
            backed,
            "people/alice-example",
            json!("people/alice-example")
        )
    ));

    assert!(link(
        &b,
        "default",
        to(plain, "people/alice-example", Value::Null)
    ));
    assert!(link(
        &b,
        "default",
        to(named, "people/alice-example", json!("alice"))
    ));
    // Linked once, the row no longer matches.
    assert!(!link(
        &b,
        "default",
        to(plain, "people/alice-example", Value::Null)
    ));

    let mut ids: Vec<u64> = on_entity(&b, "default", "people/alice-example")
        .into_iter()
        .filter(|r| r.1 == json!("relinked"))
        .map(|r| r.0)
        .collect();
    ids.sort_unstable();
    assert_eq!(ids, vec![plain, named]);
}

#[test]
fn a_lapsed_or_expired_conversation_row_does_not_link() {
    let b = brain("relink-conversation-live");
    page(&b, "default", "people/alice-example");
    let slug = "conversations/2026-01-02";
    let lapsed = derived(
        &b,
        "default",
        slug,
        json!({ "valid_until": "2001-01-01T00:00:00Z" }),
    );
    let expired = derived(&b, "default", slug, json!({}));
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired })))
        .unwrap();
    for id in [lapsed, expired] {
        assert!(!link(
            &b,
            "default",
            json!({
                "factId": id, "pageSlug": slug, "fact": "met at the cafe", "entitySlug": "people/alice-example",
                "context": "relinked", "from": null,
            })
        ));
    }
}

fn pick(b: &Brain, source_id: &str, limit: u32, unbacked: bool, skip_tried: bool) -> Vec<String> {
    let q: ConversationRelinkPagesQuery = args(json!({
        "limit": limit, "unbacked": unbacked, "skipTried": skip_tried,
        "rearmedReasons": ["no_mention", "no_page"],
    }));
    b.list_conversation_relink_pages(source_id, &q).unwrap()
}

#[test]
fn the_page_pick_counts_rows_and_breaks_ties_by_slug_bytes() {
    let b = brain("relink-pages");
    source(&b, "s2");
    page(&b, "default", "people/alice-example");
    page(&b, "default", "bob");
    let rows = |slug: &str, n: usize, extra: Value| -> Vec<u64> {
        (0..n)
            .map(|i| {
                let mut row = extra.clone();
                row["fact"] = json!(format!("{slug} claim {i}"));
                derived(&b, "default", slug, row)
            })
            .collect()
    };
    rows("conversations/top", 3, json!({}));
    rows("conversations/B-page", 2, json!({}));
    rows("conversations/a-page", 2, json!({}));
    derived(&b, "s2", "conversations/a-page", json!({}));
    let miss = |id: u64, reason: &str| {
        let a: AttemptInput = args(json!({
            "factId": id, "outcome": "conversation_unresolved", "reason": reason, "tier": "mention",
        }));
        b.upsert_fact_relink_attempt("default", &a, &UpsertOptions::default())
            .unwrap();
    };
    for id in rows("conversations/tried", 2, json!({})) {
        miss(id, "ambiguous");
    }
    for id in rows("conversations/rearmed", 1, json!({})) {
        miss(id, "no_page");
    }
    // A page created after the attempt re-arms the no_page miss.
    b.clock.advance(1_000);
    page(&b, "default", "people/new-example");
    rows(
        "conversations/noise",
        1,
        json!({ "attributed_to": "assistant" }),
    );
    rows("conversations/noise", 1, json!({ "source": TERMINAL }));
    rows("conversations/noise", 1, json!({ "source": "chat" }));
    rows(
        "conversations/noise",
        1,
        json!({ "entity_slug": "people/alice-example" }),
    );
    rows(
        "conversations/noise",
        1,
        json!({ "valid_until": "2001-01-01T00:00:00Z" }),
    );
    for id in rows("conversations/noise", 1, json!({})) {
        b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": id })))
            .unwrap();
    }
    rows("conversations/named", 2, json!({ "entity_slug": "alice" }));
    rows("conversations/named", 1, json!({ "entity_slug": "bob" }));

    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(
        pick(&b, "default", 50, false, true),
        s(&[
            "conversations/top",
            "conversations/B-page",
            "conversations/a-page",
            "conversations/rearmed"
        ])
    );
    assert_eq!(
        pick(&b, "default", 50, false, false),
        s(&[
            "conversations/top",
            "conversations/B-page",
            "conversations/a-page",
            "conversations/tried",
            "conversations/rearmed",
        ])
    );
    // Equal counts sort by slug bytes: `B` (0x42) before `a` (0x61), so the cut keeps B-page.
    assert_eq!(
        pick(&b, "default", 2, false, true),
        s(&["conversations/top", "conversations/B-page"])
    );
    assert_eq!(
        pick(&b, "default", 50, true, false),
        s(&["conversations/named"])
    );
    assert!(pick(&b, "default", 0, false, true).is_empty());
    assert_eq!(
        pick(&b, "s2", 50, false, true),
        s(&["conversations/a-page"])
    );
}
