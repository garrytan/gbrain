//! The reads behind the previews of `gbrain repair consolidate-ties`, `facts-rehome`,
//! `ontology-facts` and `duplicate-facts` (`facts/repair_previews.rs`), `fact-claim-dates` (the facts of a UTC
//! day), `url-clone-fences` (the live page of a path) and `purged-page-facts` (the gone-page candidates).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::repair::PurgedCandidatesArgs;
use gbrain_store::facts::repair_previews::{DuplicateRowsArgs, SourcesArgs, ValidDayArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::write_guards::PageByPathArgs;
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(store: &Store, slug: &str) {
    let input: PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": slug, "frontmatter": {},
    }));
    store
        .put_page(slug, &input, &args::<PutPageOptions>(json!({})))
        .unwrap();
}

/// One fact through `insert_facts`; `row` overrides the defaults. Returns its id.
fn fact(store: &Store, text: &str, row: Value) -> u64 {
    let mut input = json!({
        "fact": text, "visibility": "private", "source": "test", "row_num": null,
        "valid_from": "2026-01-01T00:00:00.000Z",
    });
    for (k, v) in row.as_object().unwrap() {
        input[k] = v.clone();
    }
    store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [input], "sourceId": "default" }),
        ))
        .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

fn sources() -> SourcesArgs {
    args(json!({ "sourceIds": ["default"] }))
}

#[test]
fn closed_ties_list_each_fact_with_its_partners() {
    let dir = TempDir::new("facts-repair-previews-ties");
    let store = open(&dir);
    let tie = |text: &str, unit: Value| {
        let id = fact(
            &store,
            text,
            json!({
                "entity_slug": "companies/acme", "claim_metric": "arr", "claim_unit": unit,
                "claim_period": "2026", "valid_until": "2026-01-01T00:00:00.000Z",
            }),
        );
        store.consolidate_fact(id as f64, 9.0).unwrap();
        id
    };
    let a = tie("ARR is 5", Value::Null);
    let b = tie("ARR is 6", Value::Null);
    // Another unit is no partner; an unconsolidated or open-ended fact is no candidate.
    let c = tie("ARR is 7 usd", json!("usd"));
    fact(
        &store,
        "ARR is 8",
        json!({ "entity_slug": "companies/acme", "claim_metric": "arr" }),
    );

    let rows = store.list_closed_consolidation_ties(&sources()).unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "source_id": "default", "id": a, "entity_slug": "companies/acme", "take_id": 9,
                "valid_from": "2026-01-01 00:00:00+00", "partners": [b] }),
            json!({ "source_id": "default", "id": b, "entity_slug": "companies/acme", "take_id": 9,
                "valid_from": "2026-01-01 00:00:00+00", "partners": [a] }),
            json!({ "source_id": "default", "id": c, "entity_slug": "companies/acme", "take_id": 9,
                "valid_from": "2026-01-01 00:00:00+00", "partners": null }),
        ]
    );
    assert!(
        store
            .list_closed_consolidation_ties(&args(json!({ "sourceIds": ["other"] })))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn pageless_entities_list_database_only_ids_and_fenced_counts() {
    let dir = TempDir::new("facts-repair-previews-pageless");
    let store = open(&dir);
    put(&store, "orgs/acme");
    let a = fact(&store, "one", json!({ "entity_slug": "companies/acme" }));
    let b = fact(&store, "two", json!({ "entity_slug": "companies/acme" }));
    fact(
        &store,
        "three",
        json!({ "entity_slug": "companies/acme", "row_num": 4 }),
    );
    fact(
        &store,
        "fenced only",
        json!({ "entity_slug": "people/bo", "row_num": 1 }),
    );
    let had_page = fact(&store, "has a page", json!({ "entity_slug": "orgs/acme" }));
    fact(&store, "no entity", json!({}));
    store.soft_delete_page("orgs/acme", None).unwrap();

    let rows = store.list_pageless_entity_facts(&sources()).unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "source_id": "default", "slug": "companies/acme", "ids": [a, b], "fenced": 1 }),
            json!({ "source_id": "default", "slug": "orgs/acme", "ids": [had_page], "fenced": 0 }),
            json!({ "source_id": "default", "slug": "people/bo", "ids": null, "fenced": 1 }),
        ]
    );
    put(&store, "people/bo");
    assert_eq!(
        store.list_pageless_entity_facts(&sources()).unwrap().len(),
        2
    );
}

#[test]
fn ontology_candidates_carry_the_fence_signature_and_their_flags() {
    let dir = TempDir::new("facts-repair-previews-ontology");
    let store = open(&dir);
    let obs = |text: &str, row: Value| {
        let mut base = json!({
            "entity_slug": "people/ana", "dimension": "role", "value": text, "value_hash": text,
            "source": "mine", "source_markdown_slug": "mine",
        });
        for (k, v) in row.as_object().unwrap() {
            base[k] = v.clone();
        }
        fact(&store, text, base)
    };
    // Fenced by the fence step: a row number and a page that is not the provenance.
    let fenced = obs(
        "cto",
        json!({ "row_num": 2, "source_markdown_slug": "people/ana" }),
    );
    let retired = obs("ceo", json!({ "source_markdown_slug": "people/ana" }));
    store
        .expire_fact(&args(
            json!({ "id": retired, "at": "2026-02-03T04:05:06.123456Z" }),
        ))
        .unwrap();
    let consolidated = obs("cfo", json!({ "source_markdown_slug": "people/ana" }));
    store.consolidate_fact(consolidated as f64, 3.0).unwrap();
    // The same observation under its own provenance makes `dup` a duplicate once restored.
    let dup = obs("coo", json!({ "source_markdown_slug": "people/ana" }));
    obs("coo", json!({}));
    let withdrawn = obs("cmo", json!({ "source_markdown_slug": "people/ana" }));
    store
        .insert_fact_withdrawal("default", "private", "cmo", "*", None)
        .unwrap();
    // Not candidates: untouched provenance, no dimension, a conversation slot.
    obs("cio", json!({}));
    fact(
        &store,
        "plain",
        json!({ "entity_slug": "people/ana", "row_num": 3 }),
    );
    obs(
        "cxo",
        json!({ "source": "cli:extract-conversation-facts:v1", "source_markdown_slug": "chats/x" }),
    );

    let rows = store.list_ontology_fact_candidates(&sources()).unwrap();
    let got: Vec<(u64, bool, bool, bool, Value)> = rows
        .iter()
        .map(|r| {
            (
                r["id"].as_u64().unwrap(),
                r["withdrawn"].as_bool().unwrap(),
                r["consolidated"].as_bool().unwrap(),
                r["duplicate"].as_bool().unwrap(),
                r["expired_at"].clone(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (fenced, false, false, false, Value::Null),
            (
                retired,
                false,
                false,
                false,
                json!("2026-02-03T04:05:06.123456Z")
            ),
            (consolidated, false, true, false, Value::Null),
            (dup, false, false, true, Value::Null),
            (withdrawn, true, false, false, Value::Null),
        ]
    );
    assert_eq!(rows[0]["page"], "people/ana");
    assert_eq!(rows[0]["row_num"], 2);
    assert_eq!(rows[0]["source"], "mine");
}

#[test]
fn duplicate_rows_group_by_fingerprint_with_the_fenced_copy_first() {
    let dir = TempDir::new("facts-repair-previews-duplicates");
    let store = open(&dir);
    let plain = fact(&store, "Ana keeps bees", json!({}));
    let fenced = fact(
        &store,
        "  ana KEEPS bees ",
        json!({ "source": "fence", "row_num": 1, "source_markdown_slug": "people/ana" }),
    );
    // Another speaker, another visibility, an audit source, an expired and a superseded copy stand apart.
    fact(&store, "Ana keeps bees", json!({ "attributed_to": "user" }));
    fact(&store, "Ana keeps bees", json!({ "visibility": "world" }));
    fact(&store, "Ana keeps bees", json!({ "source": "audit" }));
    let gone = fact(&store, "Ana keeps bees", json!({}));
    store.expire_fact(&args(json!({ "id": gone }))).unwrap();
    fact(&store, "Bo rides", json!({}));

    let rows = store
        .list_duplicate_fact_rows(&args::<DuplicateRowsArgs>(
            json!({ "sourceIds": ["default"], "excludedSources": ["audit"] }),
        ))
        .unwrap();
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![fenced, plain]);
    assert_eq!(rows[0]["fenced"], true);
    assert_eq!(rows[1]["fenced"], false);
    assert_eq!(rows[0]["speaker"], "");
    assert_eq!(rows[0]["fp"], rows[1]["fp"]);
    assert_eq!(rows[0]["source_markdown_slug"], "people/ana");
    assert_eq!(rows[1]["row_num"], Value::Null);
}

#[test]
fn facts_on_a_valid_day_list_the_unexpired_facts_of_the_utc_day_by_id() {
    let dir = TempDir::new("facts-repair-previews-day");
    let store = open(&dir);
    let on = |text: &str, from: &str, row: Value| {
        let mut input = json!({ "valid_from": from });
        for (k, v) in row.as_object().unwrap() {
            input[k] = v.clone();
        }
        fact(&store, text, input)
    };
    let a = on(
        "a on 2025-03-14",
        "2026-02-03T23:59:59.999999Z",
        json!({ "entity_slug": "companies/acme" }),
    );
    let b = on(
        "b",
        "2026-02-03T00:00:00.000000Z",
        json!({ "valid_until": "2027-05-06T07:08:09Z", "row_num": 2, "source_markdown_slug": "notes/p" }),
    );
    // The next day, an expired fact and another source's fact are not listed.
    on("c", "2026-02-04T00:00:00.000000Z", json!({}));
    on(
        "d",
        "2026-02-03T12:00:00.000000Z",
        json!({ "expired_at": "2026-03-01T00:00:00Z" }),
    );
    let day = |source: &str, day: &str| -> Vec<Value> {
        store
            .list_facts_on_valid_day(&args::<ValidDayArgs>(
                json!({ "sourceId": source, "day": day }),
            ))
            .unwrap()
    };
    let rows = day("default", "2026-02-03");
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [a, b]
    );
    assert_eq!(rows[0]["valid_from"], "2026-02-03 23:59:59.999999+00");
    assert_eq!(rows[0]["valid_until_day"], Value::Null);
    assert_eq!(rows[0]["entity_slug"], "companies/acme");
    assert_eq!(rows[1]["valid_until_day"], "2027-05-06");
    assert_eq!(rows[1]["row_num"], 2);
    assert_eq!(rows[1]["source_markdown_slug"], "notes/p");
    assert!(day("other", "2026-02-03").is_empty());
    assert!(day("default", "2026-02-05").is_empty());
}

#[test]
fn the_live_page_of_a_path_is_read_by_source_and_origin() {
    let dir = TempDir::new("facts-repair-previews-path");
    let store = open(&dir);
    let input: PageInput = args(json!({
        "type": "note", "title": "A", "compiled_truth": "a", "frontmatter": {}, "source_path": "notes/a.md",
    }));
    store
        .put_page("notes/a", &input, &args::<PutPageOptions>(json!({})))
        .unwrap();
    let page = |source: &str, path: &str| -> Option<Value> {
        store
            .read_live_page_by_path(&args::<PageByPathArgs>(
                json!({ "sourceId": source, "path": path }),
            ))
            .unwrap()
    };
    let found = page("default", "notes/a.md").unwrap();
    assert_eq!(found["slug"], "notes/a");
    assert!(found["id"].as_u64().is_some());
    assert!(page("default", "notes/b.md").is_none());
    assert!(page("other", "notes/a.md").is_none());
    assert!(page("default", "").is_none());
}

#[test]
fn purged_candidates_list_gone_pages_with_their_flags() {
    let dir = TempDir::new("facts-repair-previews-gone");
    let store = open(&dir);
    put(&store, "notes/live");
    let withdrawn = fact(
        &store,
        "claim withdrawn",
        json!({ "source": "mcp:put_page", "context": "notes/gone-b" }),
    );
    let plain = fact(
        &store,
        "claim plain",
        json!({ "source": "mcp:put_page", "context": "notes/gone-a \u{2014} note" }),
    );
    fact(
        &store,
        "claim live",
        json!({ "source": "mcp:put_page", "context": "notes/live" }),
    );
    fact(
        &store,
        "claim filed",
        json!({ "source": "mcp:put_page", "context": "notes/gone-c", "source_markdown_slug": "notes/live", "row_num": 1 }),
    );
    store
        .insert_fact_withdrawal("default", "private", "claim withdrawn", "*", None)
        .unwrap();
    let list = |ids: Option<Vec<i64>>| {
        store
            .list_purged_page_fact_candidates(&PurgedCandidatesArgs {
                source_ids: vec!["default".into()],
                ids,
            })
            .unwrap()
    };
    let rows = list(None);
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [plain, withdrawn]
    );
    assert_eq!(rows[0]["slug"], "notes/gone-a");
    assert_eq!(rows[0]["withdrawn"], false);
    assert_eq!(rows[1]["withdrawn"], true);
    // No page was purged, so no candidate has purge evidence.
    assert!(rows.iter().all(|r| r["purged"] == false));
    assert_eq!(list(Some(vec![withdrawn as i64])).len(), 1);
    assert!(list(Some(vec![-1])).is_empty());
}
