//! `listFactsForRelevance` and `countUncomparableFacts` (`facts/trust.rs`): the search pool and its two reads.

mod memory_env;

use gbrain_store::facts::trust::{RelevanceQuery, UncomparableQuery};
use gbrain_store::facts::{InsertFactArgs, InsertFactsArgs};
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

fn page(b: &memory_env::Brain, slug: &str, frontmatter: Value) {
    let input: gbrain_store::pages::PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
    b.put_page(slug, &input, &args(json!({}))).unwrap();
}

fn literal(head: &[f64]) -> String {
    let mut v = vec!["0".to_string(); 1536];
    for (slot, x) in v.iter_mut().zip(head) {
        *slot = x.to_string();
    }
    format!("[{}]", v.join(","))
}

fn relevance(b: &memory_env::Brain, arm: &str, extra: Value) -> Vec<Value> {
    let mut q = json!({ "arm": arm, "pool": { "sourceIds": ["default"] }, "limit": 50 });
    for (k, v) in extra.as_object().unwrap() {
        if k == "pool" {
            for (pk, pv) in v.as_object().unwrap() {
                q["pool"][pk] = pv.clone();
            }
        } else {
            q[k] = v.clone();
        }
    }
    b.list_facts_for_relevance(&args::<RelevanceQuery>(q))
        .unwrap()
}

fn texts(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["fact"].as_str().unwrap()).collect()
}

#[test]
fn the_keyword_arm_ranks_by_text_match_then_newest_and_reads_the_entity_name() {
    let b = brain("facts-trust-keyword");
    for (fact, entity, from) in [
        (
            "Alice drinks green tea daily",
            "people/alice",
            "2026-01-01T00:00:00.000Z",
        ),
        (
            "tea kettle tea kettle",
            "people/bob",
            "2025-12-01T00:00:00.000Z",
        ),
        ("Cats purr", "tea-house", "2026-03-01T00:00:00.000Z"),
        ("Dogs bark", "people/dan", "2026-04-01T00:00:00.000Z"),
    ] {
        insert(
            &b,
            json!({ "fact": fact, "source": "s", "entity_slug": entity, "valid_from": from }),
        );
    }
    let hits = relevance(&b, "keyword", json!({ "terms": "tea kettle" }));
    // The row naming both words ranks first though it is the oldest; the other two tie on text and
    // come newest first; the entity name `tea-house` counts as text; Dogs never match.
    assert_eq!(
        texts(&hits),
        [
            "tea kettle tea kettle",
            "Cats purr",
            "Alice drinks green tea daily"
        ]
    );
    assert_eq!(
        texts(&relevance(
            &b,
            "keyword",
            json!({ "terms": "tea", "limit": 1 })
        ))
        .len(),
        1
    );
    assert!(relevance(&b, "keyword", json!({ "terms": "the of" })).is_empty());
    assert!(hits.iter().all(|r| r["similarity"].is_null()));
    assert_eq!(hits[0]["valid_from"], "2025-12-01T00:00:00.000000Z");
    assert!(hits[0]["attributed_to"].is_null());
}

#[test]
fn the_entity_arm_reads_one_entity_newest_first() {
    let b = brain("facts-trust-entity");
    for (fact, entity, from) in [
        ("old", "people/a", "2026-01-01T00:00:00.000Z"),
        ("new", "people/a", "2026-03-01T00:00:00.000Z"),
        ("mid", "people/a", "2026-02-01T00:00:00.000Z"),
        ("other", "people/b", "2026-04-01T00:00:00.000Z"),
    ] {
        insert(
            &b,
            json!({ "fact": fact, "source": "s", "entity_slug": entity, "valid_from": from }),
        );
    }
    let entity = json!({ "sourceId": "default", "slug": "people/a" });
    let rows = relevance(&b, "entity", json!({ "entity": entity }));
    assert_eq!(texts(&rows), ["new", "mid", "old"]);
    let other = relevance(
        &b,
        "entity",
        json!({ "entity": { "sourceId": "other", "slug": "people/a" } }),
    );
    assert!(other.is_empty());
    let missing = b.list_facts_for_relevance(&args::<RelevanceQuery>(json!({
        "arm": "entity_ended", "pool": { "sourceIds": ["default"] }, "limit": 5 })));
    assert!(missing.is_err());
}

#[test]
fn the_pool_hides_ended_audit_quarantined_deleted_and_private_rows() {
    let b = brain("facts-trust-pool");
    page(&b, "notes/open", json!({}));
    page(
        &b,
        "notes/quarantined",
        json!({ "quarantine": { "reason": "junk_pattern" } }),
    );
    page(&b, "notes/deleted", json!({}));
    page(&b, "notes/private", json!({ "visibility": "private" }));
    let mut rows = vec![
        json!({ "fact": "p-open", "source": "s", "entity_slug": "subj", "source_markdown_slug": "notes/open", "row_num": 1, "visibility": "world" }),
        json!({ "fact": "p-private-page", "source": "s", "entity_slug": "subj", "source_markdown_slug": "notes/private", "row_num": 1, "visibility": "world" }),
        json!({ "fact": "p-quarantined", "source": "s", "entity_slug": "subj", "source_markdown_slug": "notes/quarantined", "row_num": 1, "visibility": "world" }),
        json!({ "fact": "p-deleted", "source": "s", "entity_slug": "subj", "source_markdown_slug": "notes/deleted", "row_num": 1, "visibility": "world" }),
        json!({ "fact": "p-audit", "source": "cli:extract-conversation-facts:terminal:v2", "entity_slug": "subj", "visibility": "world" }),
        json!({ "fact": "p-lapsed", "source": "s", "entity_slug": "subj", "valid_until": gbrain_store::env::iso(T0 - DAY), "visibility": "world" }),
        json!({ "fact": "p-private-fact", "source": "s", "entity_slug": "subj" }),
    ];
    rows.push(
        json!({ "fact": "p-expired", "source": "s", "entity_slug": "subj", "visibility": "world" }),
    );
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": rows, "sourceId": "default" }),
    ))
    .unwrap();
    b.expire_fact(&args(
        json!({ "id": 8, "at": gbrain_store::env::iso(T0 - DAY) }),
    ))
    .unwrap();
    b.soft_delete_page("notes/deleted", None).unwrap();
    let entity = json!({ "sourceId": "default", "slug": "subj" });

    let all = relevance(&b, "entity", json!({ "entity": entity }));
    let mut names = texts(&all);
    names.sort_unstable();
    assert_eq!(names, ["p-open", "p-private-fact", "p-private-page"]);
    let world = relevance(
        &b,
        "entity",
        json!({ "entity": entity, "pool": { "worldOnly": true } }),
    );
    let mut names = texts(&world);
    names.sort_unstable();
    assert_eq!(names, ["p-open", "p-private-page"]);
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage" });
    let public = relevance(
        &b,
        "entity",
        json!({ "entity": entity, "pool": { "excludePrivate": policy } }),
    );
    let mut names = texts(&public);
    names.sort_unstable();
    assert_eq!(names, ["p-open", "p-private-fact"]);
    // `includeExpired` also pools the lapsed and expired rows, never the audit or hidden ones.
    let wide = relevance(
        &b,
        "entity",
        json!({ "entity": entity, "pool": { "includeExpired": true } }),
    );
    let mut names = texts(&wide);
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "p-expired",
            "p-lapsed",
            "p-open",
            "p-private-fact",
            "p-private-page"
        ]
    );
}

#[test]
fn the_filters_narrow_the_pool_by_entity_session_time_and_text() {
    let b = brain("facts-trust-filters");
    for (fact, entity, session, from) in [
        (
            "Alpha 100% sure",
            "people/a",
            Some("s1"),
            "2026-01-01T00:00:00.000Z",
        ),
        (
            "Alpha plain",
            "people/a",
            Some("s2"),
            "2026-03-01T00:00:00.000Z",
        ),
        (
            "Alpha other entity",
            "people/b",
            Some("s1"),
            "2026-03-01T00:00:00.000Z",
        ),
    ] {
        let mut input =
            json!({ "fact": fact, "source": "s", "entity_slug": entity, "valid_from": from });
        if let Some(session) = session {
            input["source_session"] = json!(session);
        }
        insert(&b, input);
    }
    let kw = |pool: Value| {
        texts(&relevance(
            &b,
            "keyword",
            json!({ "terms": "alpha", "pool": pool }),
        ))
        .len()
    };
    assert_eq!(kw(json!({})), 3);
    assert_eq!(
        kw(json!({ "entities": [{ "sourceId": "default", "slug": "people/a" }] })),
        2
    );
    assert_eq!(
        kw(json!({ "entities": [{ "sourceId": "other", "slug": "people/a" }] })),
        0
    );
    assert_eq!(kw(json!({ "sessionId": "s1" })), 2);
    assert_eq!(kw(json!({ "since": "2026-02-01T00:00:00.000Z" })), 2);
    assert_eq!(kw(json!({ "grep": "%100\\%%" })), 1);
    assert_eq!(kw(json!({ "grep": "%ALPHA PLAIN%" })), 1);
}

#[test]
fn similarity_is_the_cosine_of_a_comparable_row_and_null_otherwise() {
    let b = brain("facts-trust-similarity");
    for (fact, head, model) in [
        ("sim-near", vec![0.3, 0.25, 0.05], Some("m1")),
        ("sim-far", vec![0.1, 1.0 / 3.0, 0.7], Some("m1")),
        ("sim-other-model", vec![0.3, 0.2, 0.1], Some("m2")),
        ("sim-no-model", vec![0.3, 0.2, 0.1], None),
    ] {
        let mut input = json!({ "fact": fact, "source": "s", "entity_slug": "subj", "embedding": literal(&head) });
        if let Some(model) = model {
            input["embedding_model"] = json!(model);
        }
        insert(&b, input);
    }
    insert(
        &b,
        json!({ "fact": "sim-bare", "source": "s", "entity_slug": "subj" }),
    );
    let vector = json!({ "literal": literal(&[0.3, 0.2, 0.1]), "model": "m1", "dims": 1536 });
    let rows = relevance(
        &b,
        "entity",
        json!({ "entity": { "sourceId": "default", "slug": "subj" }, "vector": vector }),
    );
    let sim = |name: &str| rows.iter().find(|r| r["fact"] == name).unwrap()["similarity"].as_f64();
    assert!((sim("sim-near").unwrap() - 0.9851).abs() < 1e-3);
    assert!(sim("sim-far").unwrap() < sim("sim-near").unwrap());
    for name in ["sim-other-model", "sim-no-model", "sim-bare"] {
        assert_eq!(sim(name), None, "{name}");
    }
    let wrong_dims = json!({ "literal": literal(&[0.3]), "model": "m1", "dims": 3 });
    let rows = relevance(
        &b,
        "entity",
        json!({ "entity": { "sourceId": "default", "slug": "subj" }, "vector": wrong_dims }),
    );
    assert!(rows.iter().all(|r| r["similarity"].is_null()));
}

#[test]
fn uncomparable_facts_are_counted_per_source_by_the_declared_or_undeclared_rule() {
    let b = brain("facts-trust-uncomparable");
    for (fact, embedding, model) in [
        ("ok", Some(literal(&[1.0])), Some("m1")),
        ("no-vector", None, Some("m1")),
        ("other-model", Some(literal(&[1.0])), Some("m2")),
        ("no-model", Some(literal(&[1.0])), None),
    ] {
        let mut input = json!({ "fact": fact, "source": "s", "entity_slug": "subj" });
        if let Some(e) = embedding {
            input["embedding"] = json!(e);
        }
        if let Some(m) = model {
            input["embedding_model"] = json!(m);
        }
        insert(&b, input);
    }
    let count = |declared: bool, dims: usize, pool: Value| {
        let mut q = json!({ "pool": { "sourceIds": ["default", "other"] }, "dims": dims, "model": "m1", "declared": declared });
        for (k, v) in pool.as_object().unwrap() {
            q["pool"][k] = v.clone();
        }
        b.count_uncomparable_facts(&args::<UncomparableQuery>(q))
            .unwrap()
    };
    // Declared: a missing vector or model, or another model, counts (the model-less vector too).
    assert_eq!(
        count(true, 1536, json!({})),
        [json!({ "source_id": "default", "n": 3 })]
    );
    // Undeclared, three-valued: only the row with no vector or another model counts; a NULL model is unknown.
    assert_eq!(
        count(false, 1536, json!({})),
        [json!({ "source_id": "default", "n": 2 })]
    );
    // Another length makes every vector uncomparable.
    assert_eq!(
        count(false, 3, json!({})),
        [json!({ "source_id": "default", "n": 4 })]
    );
    assert!(count(false, 1536, json!({ "worldOnly": true })).is_empty());
}
