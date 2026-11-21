//! The forget commit's statements (`trust/withdrawal_commit.rs`): the lock read of the fact a
//! withdrawal names, the context note, the page revision bump and read, the review queue row, and
//! the withdrawal row a `fact_withdrawn` refusal names.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::cycle::PageCoordinate;
use gbrain_store::memory_mutation_reads::WithdrawalClaimQuery;
use gbrain_store::trust::withdrawal_commit::WithdrawnClaimQuery;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str) -> Value {
    let input: gbrain_store::pages::PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": "x" }));
    b.put_page(slug, &input, &args(json!({}))).unwrap()
}

fn fact(b: &Brain, name: &str, page: &str, visibility: &str, row: u32) -> i64 {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": name, "entity_slug": "people/e-example", "source_markdown_slug": page,
                "row_num": row, "kind": "fact", "visibility": visibility, "source": "fence" }],
            "sourceId": "default",
        })))
        .unwrap();
    out["ids"][0].as_i64().unwrap()
}

fn lock(b: &Brain, id: i64, world_only: bool, member_page: Option<&str>) -> Option<Value> {
    let q: WithdrawalClaimQuery = args(json!({ "id": id, "sourceId": "default",
        "worldOnly": world_only, "memberPage": member_page, "remoteFloor": null }));
    b.lock_fact_for_withdrawal(&q).unwrap()
}

#[test]
fn the_lock_read_admits_a_world_fact_and_a_private_one_on_the_member_page() {
    let b = brain("withdrawal-commit-lock");
    page(&b, "notes/a");
    let world = fact(&b, "Erin rows boats.", "notes/a", "world", 1);
    let private = fact(&b, "Erin hates rain.", "notes/a", "private", 2);
    let got = lock(&b, world, true, None).unwrap();
    assert_eq!(
        (&got["visibility"], &got["fact"], &got["subject"]),
        (
            &json!("world"),
            &json!("Erin rows boats."),
            &json!("people/e-example")
        )
    );
    assert!(lock(&b, private, true, None).is_none());
    assert!(lock(&b, private, true, Some("notes/other")).is_none());
    assert_eq!(
        lock(&b, private, true, Some("notes/a")).unwrap()["visibility"],
        "private"
    );
    assert_eq!(
        lock(&b, private, false, None).unwrap()["visibility"],
        "private"
    );
    assert!(lock(&b, world + 1000, false, None).is_none());
}

#[test]
fn the_forget_note_joins_the_context_and_the_revision_bump_skips_segmented_pages() {
    let b = brain("withdrawal-commit-writes");
    let before = page(&b, "notes/a");
    let id = fact(&b, "Erin rows boats.", "notes/a", "world", 1);
    b.append_fact_forget_reason(id, "default", "forgotten: one")
        .unwrap();
    b.append_fact_forget_reason(id, "default", "forgotten: two")
        .unwrap();
    b.append_fact_forget_reason(id, "other", "forgotten: never")
        .unwrap();
    let rows = b
        .list_facts_for_page(&args::<PageCoordinate>(
            json!({ "sourceId": "default", "slug": "notes/a" }),
        ))
        .unwrap();
    assert_eq!(rows[0]["context"], "forgotten: one | forgotten: two");

    let slugs = vec!["notes/a".to_string(), "notes/missing".to_string()];
    assert!(
        b.list_segmented_pages_by_slug("default", &slugs)
            .unwrap()
            .is_empty()
    );
    let bumped = b.bump_withdrawn_page_revisions("default", &slugs).unwrap();
    assert_eq!(bumped.len(), 1);
    assert_eq!(bumped[0]["slug"], "notes/a");
    assert_ne!(
        bumped[0]["knowledge_revision"],
        before["knowledge_revision"]
    );
    let id = bumped[0]["id"].as_i64().unwrap();
    let read = b.read_page_revisions(&[id, id, -1, id + 1000]).unwrap();
    assert_eq!(read, vec![bumped[0].clone()]);
    assert!(
        b.bump_withdrawn_page_revisions("other", &slugs)
            .unwrap()
            .is_empty()
    );

    b.queue_withdrawal_review("default", &format!("fact:{id}"))
        .unwrap();
    b.queue_withdrawal_review("default", &format!("fact:{id}"))
        .unwrap();
    let due = b
        .list_due_decide_review_queue("withdraw", "default", 10)
        .unwrap();
    assert_eq!(due.len(), 1);
}

#[test]
fn the_withdrawn_row_names_the_most_specific_subject_first() {
    let b = brain("withdrawal-commit-withdrawn");
    let spec = |entity: Option<&str>| -> WithdrawnClaimQuery {
        args(
            json!({ "sourceId": "default", "visibility": "world", "fact": "Erin rows boats.",
            "entitySlug": entity, "ownedPage": null, "remoteFloor": null }),
        )
    };
    assert!(
        b.read_fact_withdrawn_row(&spec(Some("people/e-example")))
            .unwrap()
            .is_none()
    );
    b.insert_fact_withdrawal(
        "default",
        "world",
        "Erin rows boats.",
        "*",
        Some("2026-03-01T10:00:00.000000Z"),
    )
    .unwrap();
    b.insert_fact_withdrawal(
        "default",
        "world",
        "Erin rows boats.",
        "people/e-example",
        Some("2026-02-01T10:00:00.000000Z"),
    )
    .unwrap();
    let got = b
        .read_fact_withdrawn_row(&spec(Some("people/e-example")))
        .unwrap()
        .unwrap();
    assert_eq!(got["subject"], "people/e-example");
    assert_eq!(got["visibility"], "world");
    assert!(
        got["withdrawn_at"]
            .as_str()
            .unwrap()
            .starts_with("2026-02-01T10:00:00")
    );
    let wild = b.read_fact_withdrawn_row(&spec(None)).unwrap().unwrap();
    assert_eq!(wild["subject"], "*");
    let other: WithdrawnClaimQuery = args(json!({ "sourceId": "default", "visibility": "private",
        "fact": "Erin rows boats.", "entitySlug": null, "ownedPage": null, "remoteFloor": null }));
    assert!(b.read_fact_withdrawn_row(&other).unwrap().is_none());
    // The backing read needs the floor.
    assert!(b.read_fact_withdrawn_backing(&spec(None)).is_err());
}

#[test]
fn page_revisions_answer_each_known_page_once_with_its_current_revision() {
    let b = brain("withdrawal-page-revisions");
    assert!(b.read_page_revisions(&[1, -1, 99]).unwrap().is_empty());
    let a = page(&b, "notes/a");
    let c = page(&b, "notes/c");
    let (a_id, c_id) = (a["id"].as_i64().unwrap(), c["id"].as_i64().unwrap());
    let rows = b
        .read_page_revisions(&[c_id, a_id, a_id, -1, c_id + 1000])
        .unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "id": a_id, "slug": "notes/a", "knowledge_revision": a["knowledge_revision"] }),
            json!({ "id": c_id, "slug": "notes/c", "knowledge_revision": c["knowledge_revision"] }),
        ]
    );
}
