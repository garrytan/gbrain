//! Two guards a fact write and a fact read keep that the SQL engines keep in the database: the withdrawal ledger
//! (`gbrain_preserve_fact_withdrawal`, a `BEFORE` row trigger on `facts`) and the entity-page privacy of a bare name key
//! (`privateEntityFilterForCaller`).

mod memory_env;

use gbrain_store::facts::{FactQuery, InsertFactsArgs};
use memory_env::brain;
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn insert(b: &memory_env::Brain, rows: Value) {
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": rows, "sourceId": "default" }),
    ))
    .unwrap();
}

fn by_entity(b: &memory_env::Brain, entity: &str, extra: Value) -> Vec<Value> {
    let mut q =
        json!({ "sourceId": "default", "entitySlug": entity, "activeOnly": false, "limit": 50 });
    for (k, v) in extra.as_object().unwrap() {
        q[k] = v.clone();
    }
    b.list_facts_by_entity(&args::<FactQuery>(q)).unwrap()
}

fn put_page(b: &memory_env::Brain, slug: &str, frontmatter: Value) {
    let page: gbrain_store::pages::PageInput = args(json!({
        "type": "person", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
    b.put_page(slug, &page, &args(json!({}))).unwrap();
}

const WITHDRAWN_AT: &str = "2026-03-01T10:00:00.000000Z";

#[test]
fn a_row_saved_after_its_claim_was_withdrawn_is_saved_expired() {
    let b = brain("facts-withdrawal-reimport");
    b.insert_fact_withdrawal("default", "world", "x", "people/a", Some(WITHDRAWN_AT))
        .unwrap();
    insert(
        &b,
        json!([{ "fact": "x", "source": "s", "entity_slug": "people/a", "visibility": "world" }]),
    );
    let rows = by_entity(&b, "people/a", json!({}));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["expired_at"], json!(WITHDRAWN_AT), "{rows:?}");
    assert_eq!(rows[0]["valid_until"], json!(WITHDRAWN_AT), "{rows:?}");
    assert!(by_entity(&b, "people/a", json!({ "activeOnly": true })).is_empty());
}

#[test]
fn a_withdrawal_reaches_only_the_rows_the_trigger_names() {
    let b = brain("facts-withdrawal-reach");
    b.insert_fact_withdrawal("default", "world", "x", "people/a", Some(WITHDRAWN_AT))
        .unwrap();
    b.insert_fact_withdrawal(
        "default",
        "world",
        "y",
        "memory/members/m1",
        Some(WITHDRAWN_AT),
    )
    .unwrap();
    insert(
        &b,
        json!([
            // another subject, another visibility, another claim: all stay active
            { "fact": "x", "source": "s", "entity_slug": "people/b", "visibility": "world" },
            { "fact": "x", "source": "s", "entity_slug": "people/a", "visibility": "private" },
            { "fact": "z", "source": "s", "entity_slug": "people/a", "visibility": "world" },
            // an unbacked name key matches a withdrawal under any subject but an owned memory page
            { "fact": "x", "source": "s", "entity_slug": "bare-name", "visibility": "world" },
            { "fact": "y", "source": "s", "entity_slug": "bare-name", "visibility": "world" },
            // a row on a member page matches only that page's own withdrawals
            { "fact": "x", "source": "s", "entity_slug": "people/a", "visibility": "world",
              "source_markdown_slug": "memory/members/m2" },
            { "fact": "y", "source": "s", "entity_slug": "people/q", "visibility": "world",
              "source_markdown_slug": "memory/members/m1" },
        ]),
    );
    let expired = |entity: &str, fact: &str| {
        by_entity(&b, entity, json!({}))
            .into_iter()
            .filter(|r| r["fact"] == fact)
            .map(|r| !r["expired_at"].is_null())
            .collect::<Vec<_>>()
    };
    assert_eq!(expired("people/b", "x"), [false]);
    assert_eq!(expired("people/a", "z"), [false]);
    assert_eq!(expired("bare-name", "x"), [true]);
    assert_eq!(expired("bare-name", "y"), [false]);
    assert_eq!(expired("people/q", "y"), [true]);
    // people/a holds the private x, the member-page x (m2's own withdrawals only) and the plain z
    let on_a: Vec<(String, bool)> = by_entity(&b, "people/a", json!({}))
        .into_iter()
        .map(|r| (r["fact"].to_string(), !r["expired_at"].is_null()))
        .collect();
    assert_eq!(
        on_a.iter().filter(|(_, expired)| *expired).count(),
        0,
        "{on_a:?}"
    );
}

#[test]
fn a_bare_name_key_reads_under_the_privacy_of_the_page_written_at_its_directory() {
    let b = brain("facts-name-key-privacy");
    put_page(
        &b,
        "people/keyed-private",
        json!({ "visibility": "private" }),
    );
    put_page(&b, "people/keyed-open", json!({}));
    insert(
        &b,
        json!([
            { "fact": "hidden", "source": "s", "entity_slug": "keyed-private", "visibility": "world" },
            { "fact": "shown", "source": "s", "entity_slug": "keyed-open", "visibility": "world" },
            { "fact": "unpaged", "source": "s", "entity_slug": "no-page-name", "visibility": "world" },
        ]),
    );
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage" });
    let read =
        |entity: &str| by_entity(&b, entity, json!({ "excludePrivate": policy.clone() })).len();
    assert_eq!(read("keyed-private"), 0);
    assert_eq!(read("keyed-open"), 1);
    assert_eq!(read("no-page-name"), 1);
    // without the policy every row is still there
    assert_eq!(by_entity(&b, "keyed-private", json!({})).len(), 1);
    // the provenance-only floor judges no entity page
    let floor = json!({ "honorAliases": true, "entityPrivacy": false, "ownerOnly": "lineage" });
    assert_eq!(
        by_entity(&b, "keyed-private", json!({ "excludePrivate": floor })).len(),
        1
    );
}

#[test]
fn a_withdrawn_claim_stays_withdrawn_when_its_page_is_renamed() {
    let b = brain("facts-withdrawal-rename");
    put_page(&b, "people/a", json!({}));
    b.insert_fact_withdrawal("default", "world", "x", "people/a", Some(WITHDRAWN_AT))
        .unwrap();
    b.update_slug("people/a", "people/b", Some("default"))
        .unwrap();
    assert!(
        !b.has_fact_withdrawal_for_subject("default", "people/a")
            .unwrap()
    );
    insert(
        &b,
        json!([{ "fact": "x", "source": "s", "entity_slug": "people/b", "visibility": "world" }]),
    );
    let rows = by_entity(&b, "people/b", json!({}));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["expired_at"], json!(WITHDRAWN_AT), "{rows:?}");
    assert!(by_entity(&b, "people/b", json!({ "activeOnly": true })).is_empty());
}
