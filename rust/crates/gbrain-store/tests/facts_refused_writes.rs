//! A refused or failed fact write leaves nothing behind: the page delete, the rows and the id counter roll back together.

mod memory_env;
use gbrain_store::error::CONSTRAINT_VIOLATION;
use gbrain_store::facts::{ExpireFactArgs, FactQuery, InsertFactsArgs};
use memory_env::brain;
use serde_json::{Value, json};
fn a<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}
fn live(b: &memory_env::Brain) -> Vec<Value> {
    b.list_facts_by_entity(&a::<FactQuery>(
        json!({"sourceId":"default","entitySlug":"people/a","activeOnly":false,"limit":50}),
    ))
    .unwrap()
}
#[test]
fn a_refused_batch_after_the_page_delete_leaves_the_page_facts_and_the_id_counter() {
    let b = brain("tmp-atomic");
    let ok = json!([{"fact":"one","source":"s","entity_slug":"people/a","source_markdown_slug":"people/a","row_num":1},
                    {"fact":"two","source":"s","entity_slug":"people/a","source_markdown_slug":"people/a","row_num":2}]);
    b.insert_facts(&a::<InsertFactsArgs>(
        json!({"rows":ok,"sourceId":"default"}),
    ))
    .unwrap();
    assert_eq!(live(&b).len(), 2);
    // delete-first, then a good row, then a bad row (no source text): the whole write is refused.
    let bad = json!([{"fact":"three","source":"s","entity_slug":"people/a","source_markdown_slug":"people/a","row_num":3},
                     {"source":"s","entity_slug":"people/a"}]);
    let err = b
        .insert_facts(&a::<InsertFactsArgs>(json!({"rows":bad,"sourceId":"default",
        "deleteForPageFirst":{"slug":"people/a","sourceId":"default","excludeSourcePrefixes":[],"preserveExpiredLegacy":false}}))).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let after = live(&b);
    assert_eq!(after.len(), 2, "rows after refused batch");
    assert!(after.iter().all(|r| r["expired_at"].is_null()), "{after:?}");
    // the next id is unchanged (3)
    let out = b.insert_facts(&a::<InsertFactsArgs>(json!({"rows":[{"fact":"next","source":"s","entity_slug":"people/a"}],"sourceId":"default"}))).unwrap();
    assert_eq!(out["ids"], json!([3]));
}
#[test]
fn a_refused_expiry_with_a_missing_successor_leaves_the_row_unexpired() {
    let b = brain("tmp-atomic2");
    b.insert_facts(&a::<InsertFactsArgs>(
        json!({"rows":[{"fact":"one","source":"s","entity_slug":"people/a"}],"sourceId":"default"}),
    ))
    .unwrap();
    let err = b
        .expire_fact(&a::<ExpireFactArgs>(json!({"id":1,"supersededBy":99})))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let rows = live(&b);
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0]["expired_at"].is_null() && rows[0]["superseded_by"].is_null(),
        "{rows:?}"
    );
}
