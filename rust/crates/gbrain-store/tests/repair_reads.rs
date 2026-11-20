//! `repair_reads.rs`: the repair scans that order by byte.

mod memory_env;

use gbrain_store::facts::InsertFactArgs;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SOURCES: [&str; 3] = ["ab", "a0", "a-z"];

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn sources(b: &Brain) {
    for id in SOURCES {
        b.upsert_source(&args::<SourceInput>(json!({ "id": id, "name": id })))
            .unwrap();
    }
}

fn ids() -> Vec<String> {
    SOURCES.iter().map(|s| s.to_string()).collect()
}

fn page(b: &Brain, source_id: &str, slug: &str) {
    let input: PageInput = args(json!({ "type": "note", "title": slug, "compiled_truth": "body" }));
    let options: PutPageOptions = args(json!({ "sourceId": source_id }));
    b.put_page(slug, &input, &options).unwrap();
}

fn fact(b: &Brain, source_id: &str, entity: &str, text: &str, extra: Value) -> u64 {
    let mut input =
        json!({ "fact": text, "source": "test", "entity_slug": entity, "visibility": "world" });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    b.insert_fact(&args::<InsertFactArgs>(
        json!({ "input": input, "sourceId": source_id }),
    ))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn column(rows: &[Value], name: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[name].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn orphaned_aliases_count_and_list_by_byte_and_skip_live_and_soft_deleted_targets() {
    let b = brain("repair-reads-aliases");
    sources(&b);
    for source in SOURCES {
        for slug in ["z/one", "a-b"] {
            page(&b, source, &format!("old/{slug}"));
            b.update_slug(&format!("old/{slug}"), slug, Some(source))
                .unwrap();
            b.delete_page(slug, Some(source)).unwrap();
        }
        page(&b, source, "old/live");
        b.update_slug("old/live", "live", Some(source)).unwrap();
        page(&b, source, "old/soft");
        b.update_slug("old/soft", "soft", Some(source)).unwrap();
        b.soft_delete_page("soft", Some(source)).unwrap();
    }
    let counts = b.count_orphaned_alias_rows().unwrap();
    assert_eq!(column(&counts, "source_id"), ["a-z", "a0", "ab"]);
    assert_eq!(counts[0]["slug_redirects"], 2);
    let targets = b.list_orphaned_alias_targets(&ids()).unwrap();
    let pairs: Vec<(String, String)> = targets
        .iter()
        .map(|t| {
            (
                t["source_id"].as_str().unwrap().into(),
                t["slug"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(pairs[0], ("a-z".to_string(), "a-b".to_string()));
    assert_eq!(pairs[1], ("a-z".to_string(), "z/one".to_string()));
    assert_eq!(pairs.len(), 6);
    assert_eq!(
        b.list_orphaned_alias_targets(&["a0".to_string()])
            .unwrap()
            .len(),
        2
    );
    assert_eq!(b.count_soft_deleted_alias_targets(&ids()).unwrap(), 3);
}

#[test]
fn duplicate_fact_rows_group_by_source_and_fingerprint_and_skip_audit_sources() {
    let b = brain("repair-reads-duplicates");
    sources(&b);
    for source in SOURCES {
        for _ in 0..2 {
            fact(
                &b,
                source,
                "people/alice",
                "Alice runs the example team",
                json!({}),
            );
        }
        fact(
            &b,
            source,
            "people/alice",
            "A fact nobody repeats",
            json!({}),
        );
    }
    fact(
        &b,
        "ab",
        "people/bob",
        "Bob audits",
        json!({ "source": "audit" }),
    );
    fact(
        &b,
        "ab",
        "people/bob",
        "Bob audits",
        json!({ "source": "audit" }),
    );
    let rows = b
        .list_duplicate_fact_rows(&ids(), &["audit".to_string()])
        .unwrap();
    assert_eq!(
        column(&rows, "source_id"),
        ["a-z", "a-z", "a0", "a0", "ab", "ab"]
    );
    assert_eq!(rows[0]["fenced"], false);
    assert_eq!(rows[0]["speaker"], "");
    assert_eq!(b.list_duplicate_fact_rows(&ids(), &[]).unwrap().len(), 8);
}

#[test]
fn pageless_entities_list_by_byte_with_database_only_ids() {
    let b = brain("repair-reads-pageless");
    sources(&b);
    for source in SOURCES {
        for slug in ["people/z", "people/a-b"] {
            fact(&b, source, slug, "A fact", json!({}));
        }
        fact(&b, source, "people/home", "A fact", json!({}));
        page(&b, source, "people/home");
    }
    let rows = b.list_pageless_entity_facts(&ids()).unwrap();
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0]["source_id"], "a-z");
    assert_eq!(rows[0]["slug"], "people/a-b");
    assert_eq!(rows[1]["slug"], "people/z");
    assert_eq!(rows[0]["fenced"], 0);
    assert!(rows[0]["ids"].is_array());
}

#[test]
fn source_incarnations_list_named_sources_by_byte() {
    let b = brain("repair-reads-incarnations");
    sources(&b);
    let mut named = ids();
    named.push("missing".into());
    let rows = b.list_source_incarnations(&named).unwrap();
    assert_eq!(column(&rows, "id"), ["a-z", "a0", "ab"]);
    assert!(rows[0]["incarnation"].is_string());
}

#[test]
fn closed_ties_list_facts_closed_at_their_own_instant_with_partners() {
    let b = brain("repair-reads-ties");
    sources(&b);
    let tie = json!({
        "claim_metric": "mrr", "valid_from": "2026-01-01T00:00:00Z", "valid_until": "2026-01-01T00:00:00Z",
    });
    for source in SOURCES {
        let first = fact(&b, source, "companies/acme", "MRR reading 1", tie.clone());
        let second = fact(&b, source, "companies/acme", "MRR reading 2", tie.clone());
        for id in [first, second] {
            b.consolidate_fact(id as f64, 1.0).unwrap();
        }
        fact(
            &b,
            source,
            "companies/acme",
            "Alone",
            json!({ "claim_metric": "mrr" }),
        );
    }
    let rows = b.list_closed_consolidation_ties(&ids()).unwrap();
    assert_eq!(
        column(&rows, "source_id"),
        ["a-z", "a-z", "a0", "a0", "ab", "ab"]
    );
    assert_eq!(rows[0]["valid_from"], "2026-01-01 00:00:00+00");
    assert_eq!(rows[0]["take_id"], 1);
    assert_eq!(rows[0]["partners"], json!([rows[1]["id"]]));
}
