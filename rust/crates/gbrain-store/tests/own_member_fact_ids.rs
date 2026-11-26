//! memory_recall's own-page flag (`read_own_member_fact_ids`, facts/recall.rs): of the ids asked, the private facts of the source
//! that sit on the caller's own live member page, when that page names the member as a reader and passes the page policy sent.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::recall::OwnMemberArgs;
use gbrain_store::pages::PageInput;
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(b: &Brain, source: &str, slug: &str, frontmatter: Value) {
    let page: PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
    b.put_page(slug, &page, &args(json!({ "sourceId": source })))
        .unwrap();
}

fn fact(b: &Brain, source: &str, page: &str, visibility: &str, row: u32) -> u64 {
    let rows: InsertFactsArgs = args(json!({
        "rows": [{ "fact": format!("own page fact {row}"), "entity_slug": null, "source_markdown_slug": page,
            "row_num": row, "kind": "fact", "visibility": visibility, "source": "fence" }],
        "sourceId": source,
    }));
    b.insert_facts(&rows).unwrap()["ids"][0].as_u64().unwrap()
}

fn owned(b: &Brain, source: &str, member: &str, identity: &str, ids: &[u64]) -> Vec<u64> {
    let a: OwnMemberArgs = args(json!({
        "sourceId": source,
        "ids": ids.iter().map(|i| *i as f64).collect::<Vec<_>>(),
        "member": member,
        "memberPagePolicy": { "honorAliases": true, "entityPrivacy": true, "identity": [identity] },
    }));
    b.read_own_member_fact_ids(&a)
        .unwrap()
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect()
}

#[test]
fn only_private_facts_on_the_members_own_live_page_that_names_it_in_the_source_asked() {
    let b = brain("own-member-fact-ids");
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    for source in ["default", "other"] {
        put(
            &b,
            source,
            "memory/members/alice-example",
            json!({ "readable_by": ["member:alice-example"] }),
        );
    }
    put(
        &b,
        "default",
        "memory/members/bob-example",
        json!({ "readable_by": ["member:bob-example"] }),
    );
    // carol's page names someone else, not carol
    put(
        &b,
        "default",
        "memory/members/carol-example",
        json!({ "readable_by": ["member:dana-example"] }),
    );
    put(&b, "default", "notes/open", json!({}));
    let own = fact(&b, "default", "memory/members/alice-example", "private", 1);
    let own_two = fact(&b, "default", "memory/members/alice-example", "private", 2);
    let world = fact(&b, "default", "memory/members/alice-example", "world", 3);
    let bobs = fact(&b, "default", "memory/members/bob-example", "private", 4);
    let carols = fact(&b, "default", "memory/members/carol-example", "private", 5);
    let open = fact(&b, "default", "notes/open", "private", 6);
    let elsewhere = fact(&b, "other", "memory/members/alice-example", "private", 7);
    let every = [
        elsewhere, open, carols, bobs, world, own_two, own, own, 999_999,
    ];
    // by id, one row per fact, duplicates and a missing id ignored
    assert_eq!(
        owned(
            &b,
            "default",
            "alice-example",
            "member:alice-example",
            &every
        ),
        vec![own, own_two]
    );
    assert_eq!(
        owned(&b, "other", "alice-example", "member:alice-example", &every),
        vec![elsewhere]
    );
    assert_eq!(
        owned(&b, "default", "bob-example", "member:bob-example", &every),
        vec![bobs]
    );
    // the page names carol's neighbour, so it admits no one asking as carol
    assert_eq!(
        owned(
            &b,
            "default",
            "carol-example",
            "member:carol-example",
            &every
        ),
        Vec::<u64>::new()
    );
    // the page policy still judges the page: an identity its readers do not name hides it
    assert_eq!(
        owned(&b, "default", "alice-example", "member:zed-example", &every),
        Vec::<u64>::new()
    );
    assert_eq!(
        owned(&b, "default", "alice-example", "member:alice-example", &[]),
        Vec::<u64>::new()
    );
}

#[test]
fn an_id_that_is_not_a_whole_number_is_refused() {
    let b = brain("own-member-fact-ids-input");
    let a: OwnMemberArgs = args(json!({
        "sourceId": "default", "ids": [1.5], "member": "alice-example",
        "memberPagePolicy": { "honorAliases": true, "entityPrivacy": true, "identity": ["member:alice-example"] },
    }));
    assert!(b.read_own_member_fact_ids(&a).is_err());
}
