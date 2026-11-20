//! `target_probe.rs`: the copies of one slug under a read policy, by source id in byte order.

mod memory_env;

use gbrain_store::page_ops::PageReadScope;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SLUG: &str = "notes/shared";
/// en_US sorts these `a0, ab, a-z`; bytes put `a-z` first.
const MIXED: [&str; 3] = ["ab", "a0", "a-z"];

fn source(b: &Brain, id: &str) {
    b.upsert_source(&SourceInput {
        id: id.into(),
        name: Some(id.into()),
        ..SourceInput::default()
    })
    .unwrap();
}

fn page(b: &Brain, source_id: &str, slug: &str, body: &str) {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.into(),
        compiled_truth: body.into(),
        ..PageInput::default()
    };
    b.put_page(
        slug,
        &input,
        &PutPageOptions {
            source_id: Some(source_id.into()),
            ..PutPageOptions::default()
        },
    )
    .unwrap();
}

fn seeded(name: &str) -> Brain {
    let b = brain(name);
    for id in MIXED {
        source(&b, id);
        page(&b, id, SLUG, &format!("{id} body"));
    }
    b
}

fn scope(value: Value) -> PageReadScope {
    serde_json::from_value(value).unwrap()
}

fn sources_of(rows: &[Value]) -> Vec<&str> {
    rows.iter()
        .map(|r| r["source_id"].as_str().unwrap())
        .collect()
}

#[test]
fn both_members_list_the_copies_by_source_id_in_byte_order() {
    let b = seeded("target-probe-order");
    let probe = b.probe_target_rows(SLUG, &scope(json!({})), true).unwrap();
    assert_eq!(sources_of(&probe), ["a-z", "a0", "ab"]);
    let anchors = b.list_chain_anchors(SLUG, &scope(json!({}))).unwrap();
    assert_eq!(sources_of(&anchors), ["a-z", "a0", "ab"]);
    // The page id is the one the copy has.
    let ids: Vec<u64> = anchors
        .iter()
        .map(|r| r["page_id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.iter().all(|id| *id > 0));
}

#[test]
fn a_copy_reports_its_chunks_vectors_revision_state_and_chunker_version() {
    let b = seeded("target-probe-row");
    let probe = b.probe_target_rows(SLUG, &scope(json!({})), true).unwrap();
    let row = &probe[0];
    assert_eq!(row["source_id"], "a-z");
    assert!(row["chunks"].as_u64().unwrap() >= 1);
    assert_eq!(row["embedded"], 0);
    assert!(row["current"].is_boolean());
    assert!(row["chunker_version"].is_number());
}

#[test]
fn the_read_scope_narrows_the_copies_and_a_hidden_page_is_not_listed() {
    let b = seeded("target-probe-scope");
    let one = scope(json!({ "sourceId": "a0" }));
    assert_eq!(
        sources_of(&b.probe_target_rows(SLUG, &one, true).unwrap()),
        ["a0"]
    );
    let two = scope(json!({ "sourceIds": ["ab", "a-z"] }));
    assert_eq!(
        sources_of(&b.list_chain_anchors(SLUG, &two).unwrap()),
        ["a-z", "ab"]
    );
    // A deleted copy, an archived source and a slug that is not there answer nothing for that copy.
    b.soft_delete_page(SLUG, Some("a-z")).unwrap();
    b.set_source_archived("a0", true).unwrap();
    let rest = b.list_chain_anchors(SLUG, &scope(json!({}))).unwrap();
    assert_eq!(sources_of(&rest), ["ab"]);
    assert!(
        b.probe_target_rows("notes/absent", &scope(json!({})), true)
            .unwrap()
            .is_empty()
    );
}
