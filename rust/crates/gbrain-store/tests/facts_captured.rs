//! The captured-facts and facts-rehome repair statements (`facts/captured.rs`): the PGLite semantics of
//! `listActiveSourceIds`, `listFenceRewriteRows`, `expireCapturedFacts`, `listExpiredFactIds`,
//! `listPagelessEntityFacts`, `listSourceIncarnations`, `readEntityRehomeState` and `rehomeEntityFacts`.

mod memory_env;

use gbrain_store::facts::captured::{
    ExpireCapturedArgs, NamedFactsArgs, RehomeArgs, SourceIdsArgs,
};
use gbrain_store::facts::{FactQuery, InsertFactArgs, InsertFactsArgs};
use gbrain_store::ontology::OntologyObservation;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(b: &Brain, id: &str) {
    b.upsert_source(&args::<SourceInput>(json!({ "id": id, "name": id })))
        .unwrap();
}

fn page(b: &Brain, source_id: &str, slug: &str) {
    let input: PageInput = args(json!({ "type": "note", "title": slug, "compiled_truth": "body" }));
    let options: PutPageOptions = args(json!({ "sourceId": source_id }));
    b.put_page(slug, &input, &options).unwrap();
}

/// A database-only fact (no fence row) of `entity`.
fn loose(b: &Brain, source_id: &str, claim: &str, entity: Option<&str>, extra: Value) -> u64 {
    let mut input = json!({ "fact": claim, "source": "chat", "entity_slug": entity });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    b.insert_fact(&args::<InsertFactArgs>(
        json!({ "input": input, "sourceId": source_id }),
    ))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

/// A fact a page's fence holds.
fn fenced(
    b: &Brain,
    source_id: &str,
    claim: &str,
    slug: &str,
    entity: Option<&str>,
    n: i32,
) -> u64 {
    let row = json!({
        "fact": claim, "kind": "fact", "visibility": "world", "source": "fence",
        "source_markdown_slug": slug, "row_num": n, "entity_slug": entity,
    });
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": [row], "sourceId": source_id }),
    ))
    .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

fn row_of(b: &Brain, source_id: &str, entity: &str, id: u64) -> Value {
    b.list_facts_by_entity(&args::<FactQuery>(json!({
        "sourceId": source_id, "entitySlug": entity, "limit": 100, "activeOnly": false,
    })))
    .unwrap()
    .into_iter()
    .find(|r| r["id"].as_u64() == Some(id))
    .unwrap_or_else(|| panic!("fact {id} is not on {entity}"))
}

fn ids_of(rows: &[Value]) -> Vec<u64> {
    rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
}

fn named(source_id: &str, ids: &[u64]) -> NamedFactsArgs {
    args(json!({ "sourceId": source_id, "ids": ids }))
}

fn rehome(source_id: &str, from: &str, to: &str) -> RehomeArgs {
    args(json!({ "sourceId": source_id, "from": from, "to": to }))
}

fn pageless_args(ids: &[&str]) -> gbrain_store::facts::repair_previews::SourcesArgs {
    gbrain_store::facts::repair_previews::SourcesArgs {
        source_ids: ids.iter().map(|s| s.to_string()).collect(),
    }
}

fn sources(ids: &[&str]) -> SourceIdsArgs {
    args(json!({ "sourceIds": ids }))
}

#[test]
fn active_source_ids_leave_out_archived_sources_and_incarnations_keep_them() {
    let b = brain("captured-sources");
    for id in ["zeta", "alpha", "retired"] {
        source(&b, id);
    }
    b.set_source_archived("retired", true).unwrap();
    assert_eq!(
        ids_of_text(&b.list_active_source_ids().unwrap()),
        ["alpha", "default", "zeta"]
    );

    let both = b
        .list_source_incarnations(&sources(&["zeta", "retired", "missing", "default", "zeta"]))
        .unwrap();
    assert_eq!(ids_of_text(&both), ["default", "retired", "zeta"]);
    for row in &both {
        let known = b
            .get_source_by_id(row["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(row["incarnation"], json!(known.incarnation));
        assert!(!known.incarnation.is_empty());
    }
    assert_eq!(
        b.list_source_incarnations(&sources(&[])).unwrap(),
        Vec::<Value>::new()
    );
}

fn ids_of_text(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["id"].as_str().unwrap()).collect()
}

#[test]
fn fence_rewrite_rows_name_the_unexpired_facts_of_the_source() {
    let b = brain("captured-rewrite");
    source(&b, "other");
    let f1 = fenced(&b, "default", "fence one", "notes/a", Some("people/x"), 1);
    let g1 = loose(&b, "default", "db one", Some("people/x"), json!({}));
    let g2 = loose(&b, "default", "db two", None, json!({}));
    let expired = loose(&b, "default", "db expired", Some("people/x"), json!({}));
    let away = loose(&b, "other", "db away", Some("people/x"), json!({}));
    b.expire_captured_facts(&args::<ExpireCapturedArgs>(
        json!({ "sourceId": "default", "ids": [expired], "context": "x" }),
    ))
    .unwrap();

    let rows = b
        .list_fence_rewrite_rows(&named("default", &[away, g2, f1, g1, expired, f1, 0]))
        .unwrap();
    assert_eq!(ids_of(&rows), [f1, g1, g2]);
    assert_eq!(
        rows[0],
        json!({ "id": f1, "fact": "fence one", "row_num": 1 })
    );
    assert_eq!(
        rows[1],
        json!({ "id": g1, "fact": "db one", "row_num": null })
    );
    assert_eq!(
        b.list_fence_rewrite_rows(&named("default", &[])).unwrap(),
        Vec::<Value>::new()
    );
    let err = b
        .list_fence_rewrite_rows(&args(json!({ "sourceId": "default", "ids": [1.5] })))
        .unwrap_err();
    assert_eq!(err.code, "invalid_argument");
}

#[test]
fn expiring_captured_facts_puts_the_context_first_and_leaves_fenced_and_expired_rows() {
    let b = brain("captured-expire");
    source(&b, "other");
    let fence = fenced(&b, "default", "fence two", "notes/a", Some("people/x"), 2);
    let with_ctx = loose(
        &b,
        "default",
        "db one",
        Some("people/x"),
        json!({ "context": "was" }),
    );
    let bare = loose(&b, "default", "db two", Some("people/x"), json!({}));
    let empty_ctx = loose(
        &b,
        "default",
        "db three",
        Some("people/x"),
        json!({ "context": "" }),
    );
    let away = loose(&b, "other", "db away", Some("people/x"), json!({}));

    let expire = |ids: &[u64], context: &str| {
        b.expire_captured_facts(&args::<ExpireCapturedArgs>(
            json!({ "sourceId": "default", "ids": ids, "context": context }),
        ))
        .unwrap()
    };
    let done = expire(
        &[bare, with_ctx, fence, away, empty_ctx, bare],
        "expired by repair",
    );
    assert_eq!(ids_of(&done), [with_ctx, bare, empty_ctx]);
    assert!(expire(&[with_ctx, bare], "expired by repair").is_empty());

    let context = |source_id: &str, id| row_of(&b, source_id, "people/x", id)["context"].clone();
    assert_eq!(
        context("default", with_ctx),
        json!("expired by repair | was")
    );
    assert_eq!(context("default", bare), json!("expired by repair"));
    assert_eq!(context("default", empty_ctx), json!("expired by repair"));
    for id in [with_ctx, bare, empty_ctx] {
        assert!(!row_of(&b, "default", "people/x", id)["expired_at"].is_null());
    }
    assert!(row_of(&b, "default", "people/x", fence)["expired_at"].is_null());
    assert!(row_of(&b, "other", "people/x", away)["expired_at"].is_null());

    // An empty context is still a part of the join.
    let blank = loose(
        &b,
        "default",
        "db four",
        Some("people/x"),
        json!({ "context": "kept" }),
    );
    expire(&[blank], "");
    assert_eq!(context("default", blank), json!(" | kept"));

    let listed = b
        .list_expired_fact_ids(&named(
            "default",
            &[fence, with_ctx, bare, away, empty_ctx, blank],
        ))
        .unwrap();
    assert_eq!(ids_of(&listed), [with_ctx, bare, empty_ctx, blank]);
    assert_eq!(
        b.list_expired_fact_ids(&named("default", &[])).unwrap(),
        Vec::<Value>::new()
    );
}

#[test]
fn pageless_entities_and_the_rehome_of_their_database_only_facts() {
    let b = brain("captured-rehome");
    source(&b, "other");
    page(&b, "default", "people/real");
    page(&b, "default", "people/removed");
    b.soft_delete_page("people/removed", None).unwrap();
    let d1 = loose(&b, "default", "ghost one", Some("people/ghost"), json!({}));
    let d2 = loose(&b, "default", "ghost two", Some("people/ghost"), json!({}));
    let fx = fenced(
        &b,
        "default",
        "ghost fenced",
        "notes/a",
        Some("people/ghost"),
        1,
    );
    let rm = loose(
        &b,
        "default",
        "removed one",
        Some("people/removed"),
        json!({}),
    );
    let ro = loose(&b, "default", "real one", Some("people/real"), json!({}));
    loose(&b, "default", "no entity", None, json!({}));
    let o1 = loose(&b, "other", "other ghost", Some("people/ghost"), json!({}));

    let pageless = b
        .list_pageless_entity_facts(&pageless_args(&["other", "default"]))
        .unwrap();
    assert_eq!(
        pageless,
        vec![
            json!({ "source_id": "default", "slug": "people/ghost", "ids": [d1, d2], "fenced": 1 }),
            json!({ "source_id": "default", "slug": "people/removed", "ids": [rm], "fenced": 0 }),
            json!({ "source_id": "other", "slug": "people/ghost", "ids": [o1], "fenced": 0 }),
        ]
    );
    assert_eq!(
        b.list_pageless_entity_facts(&pageless_args(&[])).unwrap(),
        Vec::<Value>::new()
    );

    let state = |from, to| {
        b.read_entity_rehome_state(&rehome("default", from, to))
            .unwrap()
    };
    assert_eq!(
        state("people/ghost", "people/real"),
        json!({ "from_live": false, "to_live": true, "ids": [d1, d2] })
    );
    assert_eq!(
        state("people/real", "people/ghost"),
        json!({ "from_live": true, "to_live": false, "ids": [ro] })
    );
    assert_eq!(
        state("people/nobody", "people/removed"),
        json!({ "from_live": false, "to_live": false, "ids": null })
    );

    b.rehome_entity_facts(&rehome("default", "people/ghost", "people/real"))
        .unwrap();
    let moved = b
        .list_facts_by_entity(&args::<FactQuery>(
            json!({ "sourceId": "default", "entitySlug": "people/real", "limit": 100 }),
        ))
        .unwrap();
    let mut moved = ids_of(&moved);
    moved.sort();
    assert_eq!(moved, [d1, d2, ro]);
    let left = b
        .list_pageless_entity_facts(&pageless_args(&["default", "other"]))
        .unwrap();
    assert_eq!(
        left[0],
        json!({ "source_id": "default", "slug": "people/ghost", "ids": null, "fenced": 1 })
    );
    assert_eq!(left.len(), 3);
    // The fence-held fact stays with the entity its fence names.
    assert_eq!(
        row_of(&b, "default", "people/ghost", fx)["fact"],
        json!("ghost fenced")
    );
}

#[test]
fn a_rehome_that_collides_with_an_ontology_key_moves_nothing() {
    let b = brain("captured-collision");
    let observe = |entity: &str| {
        b.merge_ontology_fact(&args::<OntologyObservation>(json!({
            "sourceId": "default", "entitySlug": entity, "dimension": "location", "value": "Lisbon",
            "valueHash": "h-lisbon", "fact": "location: Lisbon", "confidence": 0.7, "status": "active",
            "visibility": "world", "source": "meetings/a", "validFrom": "2026-01-01T00:00:00Z",
        })))
        .unwrap()["factId"]
            .as_u64()
            .unwrap()
    };
    // The stint key is (source, entity, dimension, value hash, page, valid_from): `people/new` already holds it.
    let held = observe("people/new");
    let free = loose(&b, "default", "free", Some("people/old"), json!({}));
    let colliding = observe("people/old");
    let err = b
        .rehome_entity_facts(&rehome("default", "people/old", "people/new"))
        .unwrap_err();
    assert_eq!(err.code, "constraint_violation");
    assert!(
        err.message.contains("idx_facts_ontology_stint_dedup"),
        "{}",
        err.message
    );
    // The row that did not collide stayed with the one that did: the whole write rolled back.
    assert_eq!(
        row_of(&b, "default", "people/old", free)["entity_slug"],
        json!("people/old")
    );
    assert_eq!(
        row_of(&b, "default", "people/old", colliding)["entity_slug"],
        json!("people/old")
    );
    assert_eq!(
        row_of(&b, "default", "people/new", held)["entity_slug"],
        json!("people/new")
    );
}

#[test]
fn a_rehome_expires_a_fact_a_withdrawal_reaches_on_the_new_entity() {
    let b = brain("captured-withdrawn");
    page(&b, "default", "people/real");
    let reached = loose(
        &b,
        "default",
        "Ghost likes tea",
        Some("people/ghost"),
        json!({}),
    );
    let other = loose(
        &b,
        "default",
        "Ghost likes jam",
        Some("people/ghost"),
        json!({}),
    );
    let world = loose(
        &b,
        "default",
        "Ghost likes tea",
        Some("people/ghost"),
        json!({ "visibility": "world" }),
    );
    let withdrawn_at = "2026-03-01T12:34:56.000789Z";
    b.insert_fact_withdrawal(
        "default",
        "private",
        "Ghost likes tea",
        "people/real",
        Some(withdrawn_at),
    )
    .unwrap();
    // Another claim under another subject, and a claim at the other visibility, reach nothing.
    b.insert_fact_withdrawal(
        "default",
        "private",
        "Ghost likes jam",
        "people/elsewhere",
        Some(withdrawn_at),
    )
    .unwrap();
    b.rehome_entity_facts(&rehome("default", "people/ghost", "people/real"))
        .unwrap();
    let on = |id| row_of(&b, "default", "people/real", id);
    assert_eq!(on(reached)["expired_at"], json!(withdrawn_at));
    assert_eq!(on(reached)["valid_until"], json!(withdrawn_at));
    assert!(on(other)["expired_at"].is_null());
    assert!(on(world)["expired_at"].is_null());
}
