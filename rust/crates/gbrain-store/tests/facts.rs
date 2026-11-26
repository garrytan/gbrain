//! Facts and their supersession chains: the PGLite semantics of each member.

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::facts::{
    DuplicateQuery, ExpireFactArgs, ExpireFactUntilArgs, FactQuery, InsertFactArgs,
    InsertFactsArgs, PageDeleteArgs, SupersessionQuery, TrajectoryQuery,
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
fn expire_until_ends_at_the_given_time_else_at_the_rows_own_end_or_now() {
    let b = brain("facts-expire-until");
    let open = insert(
        &b,
        json!({ "fact": "open", "entity_slug": "people/x", "source": "s", "valid_from": iso(T0 - 10 * DAY) }),
    );
    let given = insert(
        &b,
        json!({ "fact": "given", "entity_slug": "people/x", "source": "s", "valid_from": iso(T0 - 10 * DAY) }),
    );
    let ended = insert(
        &b,
        json!({ "fact": "ended", "entity_slug": "people/x", "source": "s", "valid_from": iso(T0 - 10 * DAY), "valid_until": iso(T0 - 2 * DAY) }),
    );
    let future = insert(
        &b,
        json!({ "fact": "future", "entity_slug": "people/x", "source": "s", "valid_from": iso(T0 + 5 * DAY) }),
    );
    b.clock.advance(1_000);
    let now = iso(T0 + 1_000);
    let expire = |id: u64, until: Value| {
        b.expire_fact_until(&args::<ExpireFactUntilArgs>(
            json!({ "id": id, "until": until }),
        ))
    };
    assert!(expire(open, Value::Null).unwrap());
    assert!(expire(given, json!("2026-06-01T00:00:00.000Z")).unwrap());
    assert!(expire(ended, Value::Null).unwrap());
    assert!(expire(future, Value::Null).unwrap());
    // Idempotent-as-false: an expired row and a missing id change nothing.
    assert!(!expire(given, json!("2027-01-01T00:00:00.000Z")).unwrap());
    assert!(!expire(99, Value::Null).unwrap());
    assert_eq!(
        expire(open, json!("June 1")).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let rows = by_entity(&b, "people/x", json!({ "activeOnly": false }));
    let row = |fact: &str| rows.iter().find(|r| r["fact"] == fact).unwrap().clone();
    for fact in ["open", "given", "ended", "future"] {
        assert_eq!(row(fact)["expired_at"], now, "{fact}");
    }
    assert_eq!(row("open")["valid_until"], now);
    assert_eq!(row("given")["valid_until"], "2026-06-01T00:00:00.000000Z");
    assert_eq!(row("ended")["valid_until"], iso(T0 - 2 * DAY));
    assert_eq!(row("future")["valid_until"], iso(T0 + 5 * DAY));
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

/// A vector literal 1536 wide: `head` in the first slots, zero elsewhere.
fn literal(head: &[f64]) -> String {
    let mut v = vec!["0".to_string(); 1536];
    for (slot, x) in v.iter_mut().zip(head) {
        *slot = x.to_string();
    }
    format!("[{}]", v.join(","))
}

fn head(row: &Value, n: usize) -> Vec<f64> {
    row["embedding"].as_array().unwrap()[..n]
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

#[test]
fn a_fact_vector_is_stored_as_halfvec_with_its_model_and_text_hash() {
    let b = brain("facts-vector");
    insert(
        &b,
        json!({ "fact": "ok", "source": "s", "entity_slug": "people/ok",
            "embedding": literal(&[0.1, 1.0 / 3.0, 0.7]), "embedding_model": "m1" }),
    );
    insert(
        &b,
        json!({ "fact": "x", "source": "s", "entity_slug": "people/ok",
            "embedding": literal(&[0.5]) }),
    );
    let rows = by_entity(&b, "people/ok", json!({}));
    let ok = rows.iter().find(|r| r["fact"] == "ok").unwrap();
    assert_eq!(head(ok, 3), [0.0999755859375, 0.333251953125, 0.7001953125]);
    assert_eq!(ok["embedding"].as_array().unwrap().len(), 1536);
    assert_eq!(ok["embedding_model"], "m1");
    assert_eq!(ok["embedded_text_hash"], "444bcb3a3fcf8389296c49467f27e1d6");
    assert!(ok["embedded_at"].is_string());
    // A vector with no model is kept, with no model and no hash, as PGLite keeps it.
    let x = rows.iter().find(|r| r["fact"] == "x").unwrap();
    assert_eq!(x["embedding_model"], Value::Null);
    assert_eq!(x["embedded_text_hash"], Value::Null);
    assert!(x["embedded_at"].is_string());

    let refused = |embedding: &str| {
        b.insert_fact(&args::<InsertFactArgs>(json!({ "sourceId": "default",
            "input": { "fact": "bad", "source": "s", "embedding": embedding, "embedding_model": "m1" } })))
            .unwrap_err()
            .message
    };
    assert_eq!(refused("[1,2,3]"), "expected 1536 dimensions, not 3");
    assert_eq!(
        refused(&literal(&[70000.0])),
        "\"70000\" is out of range for type halfvec"
    );
    assert_eq!(refused("[]"), "vector must have at least 1 dimension");
}

#[test]
fn the_cosine_arm_ranks_comparable_vectors_by_halfvec_distance() {
    let b = brain("facts-cosine");
    for (fact, head, model) in [
        ("far", vec![0.1, 1.0 / 3.0, 0.7], Some("m1")),
        ("near", vec![0.3, 0.25, 0.05], Some("m1")),
        ("other-model", vec![0.3, 0.2, 0.1], Some("m2")),
        ("no-model", vec![0.3, 0.2, 0.1], None),
    ] {
        let mut input = json!({ "fact": fact, "source": "s", "entity_slug": "people/c",
            "embedding": literal(&head) });
        if let Some(model) = model {
            input["embedding_model"] = json!(model);
        }
        insert(&b, input);
        b.clock.advance(10);
    }
    let find = |model: &str, keyword: bool| {
        b.find_candidate_duplicates(&args::<DuplicateQuery>(json!({ "sourceId": "default",
            "entitySlug": "people/c", "k": 5, "keyword": keyword, "factText": "near far",
            "embedding": literal(&[0.3, 0.2, 0.1]), "embeddingModel": model })))
            .unwrap()
    };
    assert_eq!(facts(&find("m1", false)), ["near", "far"]);
    assert_eq!(facts(&find("m2", false)), ["other-model"]);
    assert!(find("", false).is_empty());
    // The keyword arm keeps only the comparable rows.
    assert_eq!(facts(&find("m1", true)).len(), 2);
}

#[test]
fn a_trajectory_point_carries_its_vector_only_from_the_brain_model() {
    let b = brain("facts-trajectory-vector");
    b.set_config("embedding_model", "m").unwrap();
    for (fact, model) in [("ARR 1", "m"), ("ARR 2", "other")] {
        insert(
            &b,
            json!({ "fact": fact, "source": "s", "entity_slug": "companies/t", "claim_metric": "arr",
                "claim_value": 1, "embedding": literal(&[0.1]), "embedding_model": model }),
        );
        b.clock.advance(10);
    }
    let points = b
        .find_trajectory(&args::<TrajectoryQuery>(json!({ "sourceIds": ["default"],
            "entitySlug": "companies/t", "worldOnly": false, "kind": "all", "limit": 10 })))
        .unwrap();
    assert_eq!(head(&points[0], 1), [0.0999755859375]);
    assert_eq!(points[1]["embedding"], Value::Null);
}

#[test]
fn unattributed_facts_list_active_rows_with_no_entity_newest_first() {
    use gbrain_store::facts::UnattributedQuery;
    let b = brain("facts-unattributed");
    let first = insert(&b, json!({ "fact": "u-private", "source": "s" }));
    b.clock.advance(500_000);
    insert(
        &b,
        json!({ "fact": "u-world", "source": "s", "visibility": "world", "kind": "event" }),
    );
    insert(
        &b,
        json!({ "fact": "u-entity", "source": "s", "entity_slug": "people/u" }),
    );
    let gone = insert(&b, json!({ "fact": "u-forgotten", "source": "s" }));
    b.expire_fact(&args::<ExpireFactArgs>(
        json!({ "id": gone, "at": iso(T0 + DAY) }),
    ))
    .unwrap();
    insert(
        &b,
        json!({ "fact": "u-lapsed", "source": "s", "valid_until": iso(T0 - DAY) }),
    );
    let page: gbrain_store::pages::PageInput =
        args(json!({ "type": "note", "title": "Gone", "compiled_truth": "x" }));
    b.put_page("notes/gone", &page, &args(json!({}))).unwrap();
    batch(
        &b,
        json!([{ "row_num": 1, "source_markdown_slug": "notes/gone", "fact": "u-hidden",
                 "entity_slug": null, "source": "fence" }]),
    );
    b.soft_delete_page("notes/gone", None).unwrap();
    let list = |world_only: bool, limit: f64, offset: f64| {
        b.list_unattributed_facts(&args::<UnattributedQuery>(json!({
            "sourceIds": ["default", "default", "other"], "worldOnly": world_only,
            "limit": limit, "offset": offset })))
    };
    let all = list(false, 10.0, 0.0).unwrap();
    assert_eq!(facts(&all), ["u-world", "u-private"]);
    assert_eq!(all[1]["id"], json!(first));
    assert_eq!(
        all[1]["created_at"],
        iso(T0).replacen('T', " ", 1).replace(".000000Z", "+00")
    );
    assert_eq!(all[0]["kind"], "event");
    assert_eq!(all[0]["source"], "s");
    assert!(all[0]["created_at"].as_str().unwrap().ends_with(".5+00"));
    assert_eq!(facts(&list(true, 10.0, 0.0).unwrap()), ["u-world"]);
    assert_eq!(facts(&list(false, 1.0, 1.0).unwrap()), ["u-private"]);
    assert_eq!(list(false, -1.0, 0.0).unwrap_err().code, INVALID_ARGUMENT);
}

#[test]
fn exclude_private_hides_rows_the_private_provenance_policy_hides() {
    let b = brain("facts-private-provenance");
    let pages = [
        ("notes/open", "note", json!({})),
        ("notes/private", "note", json!({ "visibility": "private" })),
        (
            "notes/readers",
            "note",
            json!({ "readable_by": ["alice-example"] }),
        ),
        (
            "notes/alias",
            "note",
            json!({ "confidentiality": " Secret\t" }),
        ),
        (
            "atoms/origin-private",
            "atom",
            json!({ "visibility": "world", "source_slug": "notes/private" }),
        ),
        (
            "notes/lineage",
            "note",
            json!({ "derived_from": "notes/private.md" }),
        ),
        (
            "people/private-entity",
            "person",
            json!({ "visibility": "private" }),
        ),
    ];
    for (slug, kind, frontmatter) in pages {
        let page: gbrain_store::pages::PageInput = args(json!({
            "type": kind, "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
        b.put_page(slug, &page, &args(json!({}))).unwrap();
    }
    let rows: Vec<Value> = pages_rows(&[
        ("notes/open", "subject"),
        ("notes/private", "subject"),
        ("notes/readers", "subject"),
        ("notes/alias", "subject"),
        ("atoms/origin-private", "subject"),
        ("notes/lineage", "subject"),
        ("notes/no-page", "subject"),
        ("notes/open", "people/private-entity"),
    ]);
    batch(&b, Value::Array(rows));
    let all = by_entity(&b, "subject", json!({}));
    assert_eq!(all.len(), 7);
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" });
    let kept = by_entity(&b, "subject", json!({ "excludePrivate": policy }));
    let mut kept = facts(&kept);
    kept.sort_unstable();
    assert_eq!(kept, ["notes/no-page", "notes/open"]);
    let no_alias = by_entity(
        &b,
        "subject",
        json!({ "excludePrivate": { "honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn" } }),
    );
    assert!(facts(&no_alias).contains(&"notes/alias"));
    let entity = |entity_privacy: bool| {
        facts(&by_entity(
            &b,
            "people/private-entity",
            json!({ "excludePrivate": { "honorAliases": true, "entityPrivacy": entity_privacy, "ownerOnly": "fn" } }),
        ))
        .len()
    };
    assert_eq!(entity(true), 0);
    assert_eq!(entity(false), 1);
}

fn pages_rows(rows: &[(&str, &str)]) -> Vec<Value> {
    rows.iter()
        .enumerate()
        .map(|(i, (slug, entity))| {
            json!({ "row_num": i + 1, "source_markdown_slug": slug, "fact": slug,
                    "entity_slug": entity, "source": "fence", "visibility": "world" })
        })
        .collect()
}

#[test]
fn brain_maturity_counts_unexpired_facts_in_every_source() {
    let b = brain("facts-maturity");
    let empty = b.read_brain_maturity().unwrap();
    assert_eq!(
        (empty["pages"].clone(), empty["facts"].clone()),
        (json!(0), json!(0))
    );
    insert(
        &b,
        json!({ "fact": "Kept", "source": "chat", "valid_from": "2026-01-01T00:00:00.000Z" }),
    );
    let gone = insert(
        &b,
        json!({ "fact": "Gone", "source": "chat", "valid_from": "2026-01-01T00:00:00.000Z" }),
    );
    assert!(
        b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone })))
            .unwrap()
    );
    let after = b.read_brain_maturity().unwrap();
    assert_eq!(after["facts"], json!(1));
    // The default source dates the brain before any page exists.
    assert_eq!(after["since"], empty["since"]);
    assert!(after["since"].is_string());
}

#[test]
fn a_widening_record_admits_own_member_and_granted_open_private_facts_only() {
    let b = brain("facts-visibility-widening");
    let pages = [
        ("notes/open", json!({})),
        ("notes/private", json!({ "visibility": "private" })),
        (
            "notes/quarantined",
            json!({ "quarantine": { "reason": "x" } }),
        ),
        (
            "memory/members/alice-example",
            json!({ "readable_by": ["member:alice-example"] }),
        ),
        (
            "memory/members/bob-example",
            json!({ "readable_by": ["member:bob-example"] }),
        ),
    ];
    for (slug, frontmatter) in pages {
        let page: gbrain_store::pages::PageInput = args(json!({
            "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
        b.put_page(slug, &page, &args(json!({}))).unwrap();
    }
    let rows = [
        ("world", Some("notes/open"), "fence", "world"),
        (
            "own member",
            Some("memory/members/alice-example"),
            "fence",
            "private",
        ),
        (
            "other member",
            Some("memory/members/bob-example"),
            "fence",
            "private",
        ),
        ("granted", Some("notes/open"), "fence", "private"),
        ("private holding", Some("notes/private"), "fence", "private"),
        (
            "quarantined holding",
            Some("notes/quarantined"),
            "fence",
            "private",
        ),
        ("missing holding", Some("notes/gone"), "fence", "private"),
        ("unpaged", None, "fence", "private"),
        (
            "transcript",
            Some("notes/open"),
            "transcript:chat",
            "private",
        ),
    ];
    let rows: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, (fact, slug, source, visibility))| {
            json!({ "row_num": i + 1, "fact": fact, "entity_slug": "subject", "source_markdown_slug": slug,
                    "source": source, "visibility": visibility })
        })
        .collect();
    batch(&b, Value::Array(rows));
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "identity": ["member:alice-example"] });
    let read = |widen: Value| {
        let mut kept = facts(&by_entity(
            &b,
            "subject",
            json!({ "visibility": ["world"], "widen": widen }),
        ))
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        kept.sort_unstable();
        kept
    };
    assert_eq!(read(Value::Null), ["world"]);
    assert_eq!(
        read(json!({ "member": "alice-example", "memberPagePolicy": policy })),
        ["own member", "world"]
    );
    assert_eq!(
        read(json!({ "privateFactSources": ["default"] })),
        ["granted", "world"]
    );
    assert_eq!(read(json!({ "privateFactSources": ["other"] })), ["world"]);
    // The member page policy still judges the page: an identity its readers do not name hides it.
    let stranger = json!({ "honorAliases": true, "entityPrivacy": true, "identity": ["member:carol-example"] });
    assert_eq!(
        read(json!({ "member": "alice-example", "memberPagePolicy": stranger })),
        ["world"]
    );
    // A list that names private is never narrowed by the record.
    let both = by_entity(
        &b,
        "subject",
        json!({ "visibility": ["world", "private"], "widen": { "privateFactSources": [] } }),
    );
    assert_eq!(both.len(), 9);
    // findTrajectory's world-only read widens the same way.
    let trajectory = |widen: Value| {
        let points = b
            .find_trajectory(&args::<TrajectoryQuery>(json!({ "sourceIds": ["default"],
                "entitySlug": "subject", "worldOnly": true, "widen": widen, "limit": 50 })))
            .unwrap();
        let mut kept: Vec<String> = points
            .iter()
            .map(|p| p["text"].as_str().unwrap().to_string())
            .collect();
        kept.sort_unstable();
        kept
    };
    assert_eq!(trajectory(Value::Null), ["world"]);
    assert_eq!(
        trajectory(json!({ "member": "alice-example", "memberPagePolicy": policy })),
        ["own member", "world"]
    );
    assert_eq!(
        trajectory(json!({ "privateFactSources": ["default"] })),
        ["granted", "world"]
    );
    // The fact relevance pool's world-only rule widens the same way.
    let pool = |widen: Value| {
        let rows = b
            .list_facts_for_relevance(&args::<gbrain_store::facts::trust::RelevanceQuery>(json!({
                "arm": "entity", "limit": 50,
                "entity": { "sourceId": "default", "slug": "subject" },
                "pool": { "sourceIds": ["default"], "worldOnly": true, "widen": widen } })))
            .unwrap();
        let mut kept: Vec<String> = rows
            .iter()
            .map(|r| r["fact"].as_str().unwrap().to_string())
            .collect();
        kept.sort_unstable();
        kept
    };
    assert_eq!(pool(Value::Null), trajectory(Value::Null));
    assert_eq!(
        pool(json!({ "member": "alice-example", "memberPagePolicy": policy })),
        ["own member", "world"]
    );
    assert_eq!(
        pool(json!({ "privateFactSources": ["default"] })),
        ["granted", "world"]
    );
    // listSupersessions widens the same way.
    batch(
        &b,
        json!([
            { "row_num": 20, "fact": "granted old", "entity_slug": "subject", "source_markdown_slug": "notes/open",
              "source": "fence", "visibility": "private", "superseded_by_row": 21 },
            { "row_num": 21, "fact": "granted new", "entity_slug": "subject", "source_markdown_slug": "notes/open",
              "source": "fence", "visibility": "private" },
        ]),
    );
    let sup = |widen: Value| {
        let rows = b
            .list_supersessions(&args::<SupersessionQuery>(
                json!({ "sourceId": "default", "limit": 50, "visibility": ["world"], "widen": widen }),
            ))
            .unwrap();
        facts(&rows)
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        sup(json!({ "privateFactSources": ["default"] })),
        ["granted old"]
    );
    assert!(sup(Value::Null).is_empty());
}

/// `labelledOnlyFactSql`: a labelled-only caller reads a fact only on its own member page, while that page names it.
/// The entity and holding pages are judged without the conjunct, and with lineage on the own page is still read.
#[test]
fn a_labelled_only_caller_reads_a_fact_only_on_its_own_member_page() {
    let b = brain("facts-labelled-own-page");
    let pages = [
        (
            "memory/members/carol",
            json!({ "readable_by": ["member:carol"] }),
        ),
        (
            "memory/members/dana",
            json!({ "readable_by": ["member:dana"] }),
        ),
        ("memory/members/erin", json!({})),
        ("open/plain", json!({})),
    ];
    for (slug, frontmatter) in pages {
        let page: gbrain_store::pages::PageInput = args(json!({
            "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
        b.put_page(slug, &page, &args(json!({}))).unwrap();
    }
    batch(
        &b,
        Value::Array(pages_rows(&[
            ("memory/members/carol", "subject"),
            ("memory/members/dana", "subject"),
            ("memory/members/erin", "subject"),
            ("open/plain", "subject"),
        ])),
    );
    let read = |member: Option<&str>, lineage: bool, member_page: &str| {
        let mut policy = json!({
            "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn",
            "identity": ["member:carol"], "memberPage": member_page,
            "labelledOnly": { "identity": ["member:carol"], "satisfiedRuleIds": [], "lineage": lineage },
        });
        if let Some(member) = member {
            policy["labelledOnly"]["member"] = json!(member);
        }
        let q: FactQuery = args(
            json!({ "sourceId": "default", "entitySlug": "subject", "activeOnly": true, "limit": 50, "excludePrivate": policy }),
        );
        b.list_facts_by_entity(&q)
    };
    // The caller reads the fact on its own member page, which names it, and on no other page.
    assert_eq!(
        facts(&read(Some("carol"), false, "memory/members/carol").unwrap()),
        ["memory/members/carol"]
    );
    // Another member's page, a page that names nobody, and an open page are never the caller's own page.
    assert!(
        read(Some("dana"), false, "memory/members/dana")
            .unwrap()
            .is_empty()
    );
    assert!(
        read(Some("erin"), false, "memory/members/erin")
            .unwrap()
            .is_empty()
    );
    // No member (or one that is not a member id) reads as FALSE: no fact passes.
    assert!(
        read(None, false, "memory/members/carol")
            .unwrap()
            .is_empty()
    );
    assert!(
        read(Some("Not A Member"), false, "memory/members/carol")
            .unwrap()
            .is_empty()
    );
    // With lineage on the own page is read as before, and a page that names nobody is still not read.
    assert_eq!(
        facts(&read(Some("carol"), true, "memory/members/carol").unwrap()),
        ["memory/members/carol"]
    );
}

/// A member's fact read with `access.members_read_lineage` on (row 32e-b-4), as the TypeScript member sends it
/// (`provenanceLineage`, `ownerRead`, `callerRecord`): the first form's provenance page is judged by the member's lineage,
/// the second form's by the plain policy, and a labelled-only member also reads a fact on a page that names it or whose
/// every origin does. Another member's page and a derived page with a null origin are never read.
#[test]
fn a_member_reads_a_fact_by_its_provenance_page_under_lineage() {
    let b = brain("facts-lineage-provenance");
    let pages: [(&str, &str, Value); 8] = [
        (
            "note",
            "memory/members/carol",
            json!({ "readable_by": ["member:carol"] }),
        ),
        (
            "note",
            "memory/members/bob",
            json!({ "readable_by": ["member:bob"] }),
        ),
        ("note", "open/plain", json!({})),
        (
            "note",
            "open/origin-carol",
            json!({ "readable_by": ["member:carol"] }),
        ),
        (
            "note",
            "open/origin-dana",
            json!({ "readable_by": ["member:dana"] }),
        ),
        (
            "atom",
            "walk/atom-carol",
            json!({ "visibility": "world", "source_slug": "open/origin-carol" }),
        ),
        (
            "atom",
            "walk/atom-dana",
            json!({ "visibility": "world", "source_slug": "open/origin-dana" }),
        ),
        (
            "note",
            "walk/null-mix",
            json!({ "visibility": "world", "derived_from": ["open/origin-carol.md", null] }),
        ),
    ];
    for (kind, slug, frontmatter) in &pages {
        let page: gbrain_store::pages::PageInput = args(json!({
            "type": kind, "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
        b.put_page(slug, &page, &args(json!({}))).unwrap();
    }
    let held: Vec<(&str, &str)> = pages
        .iter()
        .map(|(_, slug, _)| (*slug, "subject"))
        .collect();
    batch(&b, Value::Array(pages_rows(&held)));
    let read = |who: &str, labelled: bool, first_form: bool, coverage: Value| {
        let mut policy = json!({
            "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn",
            "identity": [format!("member:{who}")], "ownerRead": true, "callerRecord": true,
            "provenanceLineage": first_form, "folderCoverage": coverage,
        });
        if first_form {
            policy["memberPage"] = json!(format!("memory/members/{who}"));
        }
        if labelled {
            policy["labelledOnly"] = json!({ "identity": [format!("member:{who}")], "satisfiedRuleIds": [], "lineage": true, "member": who });
        }
        let q: FactQuery = args(
            json!({ "sourceId": "default", "entitySlug": "subject", "activeOnly": true, "limit": 50, "excludePrivate": policy }),
        );
        let mut seen: Vec<String> = facts(&b.list_facts_by_entity(&q).unwrap())
            .into_iter()
            .map(str::to_string)
            .collect();
        seen.sort();
        seen
    };
    let none = json!([]);
    // Carol, labelled-only: her own page, the page that names her, and the atom whose origin does.
    assert_eq!(
        read("carol", true, true, none.clone()),
        [
            "memory/members/carol",
            "open/origin-carol",
            "walk/atom-carol"
        ]
    );
    // Dana, ordinary, first form: the open page and the atom whose origin names her; not another member's page, an origin that names
    // someone else, or the derived page with a null origin.
    assert_eq!(
        read("dana", false, true, none.clone()),
        ["open/origin-dana", "open/plain", "walk/atom-dana"]
    );
    // Dana, second form: the plain policy hides every page that names readers and every page derived from one.
    assert_eq!(read("dana", false, false, none.clone()), ["open/plain"]);
    // A pending prefix in the caller's record hides a page under it, whoever reads.
    let pending = json!([{ "source_id": "default", "prefix": "walk/" }]);
    assert_eq!(
        read("carol", true, true, pending.clone()),
        ["memory/members/carol", "open/origin-carol"]
    );
    assert_eq!(
        read("dana", false, true, pending),
        ["open/origin-dana", "open/plain"]
    );
}
