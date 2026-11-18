//! Facts and their supersession chains: the PGLite semantics of each member.

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::facts::{
    DuplicateQuery, ExpireFactArgs, FactQuery, InsertFactArgs, InsertFactsArgs, PageDeleteArgs,
    SupersessionQuery, TrajectoryQuery,
};
use memory_env::{T0, brain};
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn insert(b: &memory_env::Brain, input: Value) -> u64 {
    let out = b
        .insert_fact(&args::<InsertFactArgs>(
            json!({ "input": input, "sourceId": "default" }),
        ))
        .unwrap();
    out["id"].as_u64().unwrap()
}

fn batch(b: &memory_env::Brain, rows: Value) -> Value {
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": rows, "sourceId": "default" }),
    ))
    .unwrap()
}

fn by_entity(b: &memory_env::Brain, entity: &str, extra: Value) -> Vec<Value> {
    let mut q =
        json!({ "sourceId": "default", "entitySlug": entity, "activeOnly": true, "limit": 50 });
    for (k, v) in extra.as_object().unwrap() {
        q[k] = v.clone();
    }
    b.list_facts_by_entity(&args::<FactQuery>(q)).unwrap()
}

fn facts(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["fact"].as_str().unwrap()).collect()
}

#[test]
fn insert_fact_stores_defaults_and_lists_newest_valid_from_first() {
    let b = brain("facts-defaults");
    let a = insert(
        &b,
        json!({ "fact": "Alice likes tea", "entity_slug": "people/alice", "source": "chat",
        "valid_from": "2026-01-01T00:00:00.000Z" }),
    );
    let c = insert(
        &b,
        json!({ "fact": "Alice moved to Paris", "entity_slug": "people/alice", "source": "chat",
        "valid_from": "2026-02-01T00:00:00.000Z", "kind": "event", "visibility": "world", "confidence": 0.5 }),
    );
    assert_eq!((a, c), (1, 2));
    let rows = by_entity(&b, "people/alice", json!({}));
    assert_eq!(facts(&rows), ["Alice moved to Paris", "Alice likes tea"]);
    let tea = &rows[1];
    assert_eq!(tea["kind"], "fact");
    assert_eq!(tea["visibility"], "private");
    assert_eq!(tea["notability"], "medium");
    assert_eq!(tea["confidence"].as_f64().unwrap(), 1.0);
    assert_eq!(tea["valid_from"], "2026-01-01T00:00:00.000000Z");
    assert_eq!(tea["created_at"], iso(T0));
    assert!(tea["expired_at"].is_null());
    assert_eq!(rows[0]["confidence"].as_f64().unwrap(), 0.5);
    // Paging and the kind / visibility filters.
    assert_eq!(
        facts(&by_entity(
            &b,
            "people/alice",
            json!({ "limit": 1, "offset": 1 })
        )),
        ["Alice likes tea"]
    );
    assert_eq!(
        facts(&by_entity(
            &b,
            "people/alice",
            json!({ "kinds": ["event"] })
        )),
        ["Alice moved to Paris"]
    );
    assert_eq!(
        facts(&by_entity(
            &b,
            "people/alice",
            json!({ "visibility": ["world"] })
        )),
        ["Alice moved to Paris"]
    );
    assert!(by_entity(&b, "people/alice", json!({ "visibility": [] })).is_empty());
    // grep is ILIKE over a caller-built pattern.
    assert_eq!(
        facts(&by_entity(&b, "people/alice", json!({ "grep": "%PARIS%" }))),
        ["Alice moved to Paris"]
    );
}

#[test]
fn a_fact_with_no_source_text_or_an_unknown_source_is_refused() {
    let b = brain("facts-refuse");
    let err = b
        .insert_fact(&args::<InsertFactArgs>(
            json!({ "input": { "fact": "x", "source": "s" }, "sourceId": "nope" }),
        ))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = b
        .insert_fact(&args::<InsertFactArgs>(
            json!({ "input": { "source": "s" }, "sourceId": "default" }),
        ))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    // Nothing was written: the next fact takes id 1.
    assert_eq!(insert(&b, json!({ "fact": "ok", "source": "s" })), 1);
}

#[test]
fn supersede_and_expire_close_the_old_fact() {
    let b = brain("facts-supersede");
    let old = insert(
        &b,
        json!({ "fact": "Bob works at Acme", "entity_slug": "people/bob", "source": "s",
        "valid_from": "2026-01-01T00:00:00.000Z" }),
    );
    b.clock.advance(1_000);
    let out = b
        .insert_fact(&args::<InsertFactArgs>(json!({ "input": { "fact": "Bob works at Widget", "entity_slug": "people/bob",
            "source": "s", "valid_from": "2026-03-01T00:00:00.000Z" }, "sourceId": "default", "supersedeId": old })))
        .unwrap();
    assert_eq!(out, json!({ "id": 2, "status": "superseded" }));
    assert_eq!(
        facts(&by_entity(&b, "people/bob", json!({}))),
        ["Bob works at Widget"]
    );
    let all = by_entity(&b, "people/bob", json!({ "activeOnly": false }));
    let closed = &all[1];
    assert_eq!(closed["superseded_by"], 2);
    assert_eq!(closed["expired_at"], iso(T0 + 1_000));
    assert_eq!(closed["valid_until"], "2026-03-01T00:00:00.000000Z");
    let sup = b
        .list_supersessions(&args::<SupersessionQuery>(
            json!({ "sourceId": "default", "limit": 50 }),
        ))
        .unwrap();
    assert_eq!(facts(&sup), ["Bob works at Acme"]);
    // expireFact is idempotent and checks the successor exists.
    assert!(
        !b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": old })))
            .unwrap()
    );
    assert!(
        !b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": 99 })))
            .unwrap()
    );
    let err = b
        .expire_fact(&args::<ExpireFactArgs>(
            json!({ "id": 2, "supersededBy": 77 }),
        ))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert!(
        b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": 2 })))
            .unwrap()
    );
    assert!(by_entity(&b, "people/bob", json!({})).is_empty());
}

#[test]
fn insert_facts_skips_a_taken_fence_row_and_burns_its_id() {
    let b = brain("facts-fence");
    let out = batch(
        &b,
        json!([
            { "fact": "one", "source": "s", "source_markdown_slug": "people/a", "row_num": 1 },
            { "fact": "dup", "source": "s", "source_markdown_slug": "people/a", "row_num": 1 },
            { "fact": "two", "source": "s", "source_markdown_slug": "people/a", "row_num": 2 },
        ]),
    );
    assert_eq!(
        out,
        json!({ "inserted": 2, "ids": [1, 3], "warnings": [], "deleted": 0 })
    );
    let out = batch(
        &b,
        json!([{ "fact": "again", "source": "s", "source_markdown_slug": "people/a", "row_num": 2 }]),
    );
    assert_eq!(out["ids"], json!([]));
    assert_eq!(insert(&b, json!({ "fact": "next", "source": "s" })), 5);
}

#[test]
fn insert_facts_links_superseded_rows_and_warns_on_bad_references() {
    let b = brain("facts-links");
    let page = "people/a";
    let row = |n: i32, by: Option<f64>, struck: bool| {
        let mut r = json!({ "fact": format!("row {n}"), "source": "s", "source_markdown_slug": page, "row_num": n });
        if let Some(by) = by {
            r["superseded_by_row"] = json!(by);
        }
        if struck {
            r["expired_at"] = json!("2026-01-01T00:00:00.000Z");
        }
        r
    };
    let out = batch(
        &b,
        json!([
            row(1, None, false),
            row(2, Some(1.0), true),
            row(3, Some(3.0), true),
            row(4, Some(9.0), true),
            row(5, None, true),
            row(6, Some(5.0), true),
            row(7, Some(8.0), true),
            row(8, Some(7.0), true),
        ]),
    );
    let prefix = |own: i32, to: i32| format!("{page} row {own}: \"superseded by #{to}\"");
    assert_eq!(
        out["warnings"],
        json!([
            format!(
                "{} references itself — leaving superseded_by NULL",
                prefix(3, 3)
            ),
            format!(
                "{} names a row absent from the fence — leaving superseded_by NULL",
                prefix(4, 9)
            ),
            format!(
                "{} names a row that is itself struck (inactive) without being superseded — a supersession target must be a live or superseded row; leaving superseded_by NULL",
                prefix(6, 5)
            ),
            format!(
                "{} forms a supersession cycle — leaving superseded_by NULL",
                prefix(7, 8)
            ),
            format!(
                "{} forms a supersession cycle — leaving superseded_by NULL",
                prefix(8, 7)
            ),
        ])
    );
    // PGLite insertFacts on these rows gives the same warnings and links (probed).
    let rows = b
        .list_facts_since(&args::<FactQuery>(
            json!({ "sourceId": "default", "since": iso(T0 - DAY),
            "activeOnly": false, "limit": 50 }),
        ))
        .unwrap();
    let link =
        |fact: &str| rows.iter().find(|r| r["fact"] == fact).unwrap()["superseded_by"].clone();
    assert_eq!(link("row 2"), json!(1));
    for unlinked in ["row 3", "row 4", "row 6", "row 7", "row 8"] {
        assert!(link(unlinked).is_null(), "{unlinked}");
    }
}

#[test]
fn delete_for_page_first_replaces_a_page_and_spares_excluded_sources() {
    let b = brain("facts-replace");
    batch(
        &b,
        json!([
            { "fact": "old", "source": "extract", "source_markdown_slug": "people/a", "row_num": 1 },
            { "fact": "manual", "source": "cli:manual", "source_markdown_slug": "people/a" },
            { "fact": "other", "source": "extract", "source_markdown_slug": "people/b", "row_num": 1 },
        ]),
    );
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": "new", "source": "extract", "source_markdown_slug": "people/a", "row_num": 1 }],
            "sourceId": "default",
            "deleteForPageFirst": { "slug": "people/a", "excludeSourcePrefixes": ["cli:"] },
        })))
        .unwrap();
    assert_eq!(out["deleted"], 1);
    assert_eq!(out["ids"], json!([4]));
    let deleted = b
        .delete_facts_for_page(&args::<PageDeleteArgs>(
            json!({ "slug": "people/b", "sourceId": "default" }),
        ))
        .unwrap();
    assert_eq!(deleted, 1);
    let left = b
        .list_facts_since(&args::<FactQuery>(
            json!({ "sourceId": "default", "since": iso(T0 - DAY), "limit": 50 }),
        ))
        .unwrap();
    let mut names = facts(&left);
    names.sort();
    assert_eq!(names, ["manual", "new"]);
}

#[test]
fn an_ontology_stint_another_row_holds_is_a_unique_violation() {
    let b = brain("facts-stint");
    let row = json!({ "fact": "Carol is CEO", "source": "s", "entity_slug": "people/carol",
        "source_markdown_slug": "people/carol", "dimension": "title", "value": "CEO", "value_hash": "h",
        "valid_from": "2026-01-01T00:00:00.000Z" });
    batch(&b, json!([row.clone()]));
    let err = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [row], "sourceId": "default" }),
        ))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert!(
        err.message.contains("idx_facts_ontology_stint_dedup"),
        "{}",
        err.message
    );
}

#[test]
fn keyset_pages_oldest_first_with_no_gaps_or_repeats() {
    let b = brain("facts-keyset");
    for n in 0..5 {
        insert(&b, json!({ "fact": format!("f{n}"), "source": "s" }));
        if n != 1 {
            b.clock.advance(10);
        }
    }
    let mut seen = Vec::new();
    let mut after: Option<Value> = None;
    loop {
        let mut q = json!({ "sourceId": "default", "activeOnly": true, "limit": 2 });
        if let Some(a) = &after {
            q["after"] = a.clone();
        }
        let page = b.list_facts_keyset(&args::<FactQuery>(q)).unwrap();
        if page.is_empty() {
            break;
        }
        let last = page.last().unwrap();
        after = Some(json!({ "createdAt": last["created_at"], "id": last["id"] }));
        seen.extend(page.iter().map(|r| r["fact"].as_str().unwrap().to_string()));
    }
    assert_eq!(seen, ["f0", "f1", "f2", "f3", "f4"]);
    let err = b
        .list_facts_keyset(&args::<FactQuery>(
            json!({ "sourceId": "default", "limit": 2,
            "after": { "createdAt": "yesterday", "id": 1 } }),
        ))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn trajectory_is_chronological_and_world_only_for_remote_callers() {
    let b = brain("facts-trajectory");
    for (when, value, vis) in [
        ("2026-03-01", 30.0, "world"),
        ("2026-01-01", 10.0, "world"),
        ("2026-02-01", 20.0, "private"),
    ] {
        insert(
            &b,
            json!({ "fact": format!("MRR {value}"), "source": "s", "entity_slug": "companies/acme",
            "visibility": vis, "valid_from": format!("{when}T00:00:00.000Z"), "claim_metric": "mrr",
            "claim_value": value, "claim_unit": "USD", "claim_period": "monthly" }),
        );
    }
    let q = |world: bool| {
        args::<TrajectoryQuery>(
            json!({ "sourceIds": ["default"], "entitySlug": "companies/acme",
            "worldOnly": world, "kind": "all", "limit": 100 }),
        )
    };
    let values = |rows: Vec<Value>| {
        rows.iter()
            .map(|r| r["value"].as_f64().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(values(b.find_trajectory(&q(true)).unwrap()), [10.0, 30.0]);
    let local = b.find_trajectory(&q(false)).unwrap();
    assert_eq!(local[0]["metric"], "mrr");
    assert_eq!(local[0]["valid_from"], "2026-01-01T00:00:00.000000Z");
    assert_eq!(values(local), [10.0, 20.0, 30.0]);
}

#[test]
fn migrate_to_canonical_moves_active_rows_past_the_canonical_fence() {
    let b = brain("facts-migrate");
    batch(
        &b,
        json!([
            { "fact": "c1", "source": "s", "entity_slug": "people/dana", "source_markdown_slug": "people/dana", "row_num": 4 },
            { "fact": "p1", "source": "s", "entity_slug": "dana", "source_markdown_slug": "dana", "row_num": 1 },
            { "fact": "p2", "source": "s", "entity_slug": "dana", "source_markdown_slug": "dana", "row_num": 2,
              "expired_at": "2026-01-01T00:00:00.000Z" },
        ]),
    );
    assert_eq!(
        b.migrate_facts_to_canonical("dana", "people/dana", "default")
            .unwrap(),
        1
    );
    let page = b
        .list_facts_since(&args::<FactQuery>(
            json!({ "sourceId": "default", "since": iso(T0 - DAY),
            "sourceMarkdownSlug": "people/dana", "limit": 50 }),
        ))
        .unwrap();
    let mut names = facts(&page);
    names.sort();
    assert_eq!(names, ["c1", "p1"]);
    // p1 now holds row 5 of the canonical page (4 + its own row 1).
    let taken = batch(
        &b,
        json!([{ "fact": "x", "source": "s", "source_markdown_slug": "people/dana", "row_num": 5 }]),
    );
    assert_eq!(taken["ids"], json!([]));
    assert_eq!(
        facts(&by_entity(&b, "dana", json!({ "activeOnly": false }))),
        ["p2"]
    );
    assert_eq!(
        b.migrate_facts_to_canonical("dana", "people/dana", "default")
            .unwrap(),
        0
    );
}

#[test]
fn recency_duplicates_and_health_count_active_rows() {
    let b = brain("facts-health");
    for n in 0..3 {
        insert(
            &b,
            json!({ "fact": format!("e{n}"), "source": "s", "entity_slug": "people/eve" }),
        );
        b.clock.advance(10);
    }
    insert(
        &b,
        json!({ "fact": "f0", "source": "s", "entity_slug": "people/finn" }),
    );
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": 1 })))
        .unwrap();
    let dups = b
        .find_candidate_duplicates(&args::<DuplicateQuery>(json!({ "sourceId": "default",
            "entitySlug": "people/eve", "k": 5 })))
        .unwrap();
    assert_eq!(facts(&dups), ["e2", "e1"]);
    assert_eq!(b.count_unconsolidated_facts("default").unwrap(), 3);
    let health = b.get_facts_health("default").unwrap();
    assert_eq!(health["total_active"], 3);
    assert_eq!(health["total_expired"], 1);
    assert_eq!(
        health["top_entities"],
        json!([
            { "entity_slug": "people/eve", "count": 2 },
            { "entity_slug": "people/finn", "count": 1 },
        ])
    );
}

#[test]
fn keyword_duplicates_rank_shared_terms_then_newest() {
    let b = brain("facts-keyword");
    for (fact, source) in [
        ("Ivy runs the Berlin marathon", "s"),
        ("Ivy likes Berlin", "s"),
        ("Ivy visited Berlin", "s"),
        (
            "Ivy Berlin marathon audit",
            "cli:extract-conversation-facts:terminal:v2",
        ),
        ("Cooking notes", "s"),
    ] {
        insert(
            &b,
            json!({ "fact": fact, "source": source, "entity_slug": "people/ivy" }),
        );
        b.clock.advance(10);
    }
    let find = |text: &str| {
        b.find_candidate_duplicates(&args::<DuplicateQuery>(json!({ "sourceId": "default",
            "entitySlug": "people/ivy", "k": 5, "keyword": true, "factText": text })))
    };
    // Two shared lexemes outrank one; equal ranks put the newest row first; audit rows drop out.
    assert_eq!(
        facts(&find("Berlin marathons").unwrap()),
        [
            "Ivy runs the Berlin marathon",
            "Ivy visited Berlin",
            "Ivy likes Berlin"
        ]
    );
    // A claim of stop words only has no lexemes and matches nothing.
    assert!(find("the and of").unwrap().is_empty());
    assert_eq!(find("Berlin\0").unwrap_err().code, INVALID_ARGUMENT);
}
