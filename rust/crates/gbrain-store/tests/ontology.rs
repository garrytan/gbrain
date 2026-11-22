//! Ontology dimensions over facts: the PGLite semantics of each member.

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::ontology::{OntologyObservation, OntologyQuery};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{T0, brain};
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// An observation as the TypeScript member sends it (the value hash is any stable text here).
fn merge(b: &memory_env::Brain, extra: Value) -> Value {
    let mut o = json!({
        "sourceId": "default", "entitySlug": "people/alice", "dimension": "role", "value": "founder",
        "confidence": 0.7, "status": "active", "visibility": "private", "source": "meetings/a",
    });
    for (k, v) in extra.as_object().unwrap() {
        o[k] = v.clone();
    }
    let value = o["value"].as_str().unwrap().trim().to_lowercase();
    o["valueHash"] = json!(format!("h-{value}"));
    o["fact"] = json!(format!(
        "{}: {}",
        o["dimension"].as_str().unwrap(),
        o["value"].as_str().unwrap()
    ));
    b.merge_ontology_fact(&args::<OntologyObservation>(o))
        .unwrap()
}

fn query(extra: Value) -> OntologyQuery {
    let mut q = json!({ "entitySlug": "people/alice" });
    for (k, v) in extra.as_object().unwrap() {
        q[k] = v.clone();
    }
    args(q)
}

fn values(rows: &[Value]) -> Vec<(&str, &str)> {
    rows.iter()
        .map(|r| {
            (
                r["dimension"].as_str().unwrap(),
                r["value"].as_str().unwrap(),
            )
        })
        .collect()
}

fn put_page(b: &memory_env::Brain, slug: &str) {
    let input: PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": format!("{slug} body") }));
    b.put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

#[test]
fn an_undated_observation_starts_now_and_closes_the_prior_value_now() {
    let b = brain("ontology-undated");
    let first = merge(&b, json!({}));
    assert_eq!(
        first,
        json!({ "action": "inserted", "factId": 1, "supersededId": null })
    );
    b.clock.advance(DAY);
    let second = merge(&b, json!({ "value": "advisor", "source": "meetings/b" }));
    assert_eq!(
        second,
        json!({ "action": "superseded_prior", "factId": 2, "supersededId": 1 })
    );

    let now = b.get_ontology(&query(json!({}))).unwrap();
    assert_eq!(values(&now), vec![("role", "advisor")]);
    assert_eq!(now[0]["valid_from"], iso(T0 + DAY));
    let before = b
        .get_ontology(&query(json!({ "asof": iso(T0 + DAY / 2) })))
        .unwrap();
    assert_eq!(values(&before), vec![("role", "founder")]);
    assert_eq!(before[0]["valid_to"], iso(T0 + DAY));
    // The closed value is no longer open, so it is not a conflict.
    assert!(
        b.find_ontology_conflicts(&query(json!({})))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_undated_repeat_corroborates_once_per_provenance() {
    let b = brain("ontology-corroborate");
    merge(&b, json!({}));
    b.clock.advance(DAY);
    assert_eq!(merge(&b, json!({}))["action"], "noop");
    let other = merge(&b, json!({ "source": "meetings/b", "value": "Founder " }));
    assert_eq!(
        other,
        json!({ "action": "corroborated", "factId": 2, "supersededId": null })
    );
    // The corroborating row is stored expired: it never shows and never counts as a dimension row.
    let dims = b.discover_ontology_dimensions(&query(json!({}))).unwrap();
    assert_eq!(
        dims,
        vec![json!({ "dimension": "role", "entities": 1, "observations": 1 })]
    );
}

#[test]
fn a_soft_deleted_or_diary_provenance_is_hidden_before_each_dimension_resolves() {
    let b = brain("ontology-pages");
    put_page(&b, "meetings/new");
    merge(&b, json!({ "validFrom": "2024-01-01T00:00:00.000Z" }));
    merge(
        &b,
        json!({ "value": "advisor", "source": "meetings/new", "validFrom": "2025-01-01T00:00:00.000Z" }),
    );
    merge(
        &b,
        json!({ "dimension": "location", "value": "SF", "source": "life/diary/2025-01-02" }),
    );
    assert_eq!(
        values(&b.get_ontology(&query(json!({}))).unwrap()),
        vec![("location", "SF"), ("role", "advisor")]
    );
    assert_eq!(
        values(
            &b.get_ontology(&query(json!({ "excludeDiary": true })))
                .unwrap()
        ),
        vec![("role", "advisor")]
    );
    b.soft_delete_page("meetings/new", Some("default")).unwrap();
    // The closed founder row is not current; nothing else is open for role.
    assert_eq!(
        values(
            &b.get_ontology(&query(json!({ "excludeDiary": true })))
                .unwrap()
        ),
        Vec::<(&str, &str)>::new()
    );
    let past = b
        .get_ontology(&query(json!({ "asof": "2024-06-01T00:00:00.000Z" })))
        .unwrap();
    assert_eq!(values(&past), vec![("role", "founder")]);
}

#[test]
fn conflicts_group_across_sources_and_scope_by_source_list() {
    let b = brain("ontology-sources");
    b.upsert_source(&SourceInput {
        id: "alt".into(),
        name: Some("alt".into()),
        ..SourceInput::default()
    })
    .unwrap();
    merge(&b, json!({ "confidence": 0.9 }));
    merge(
        &b,
        json!({ "sourceId": "alt", "value": "advisor", "source": "meetings/z", "visibility": "world" }),
    );
    let all = b.find_ontology_conflicts(&query(json!({}))).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(
        all[0],
        json!({ "entity_slug": "people/alice", "dimension": "role", "values": [
            { "value": "founder", "source": "meetings/a", "confidence": 0.9, "fact_id": 1 },
            { "value": "advisor", "source": "meetings/z", "confidence": 0.7, "fact_id": 2 },
        ] })
    );
    assert!(
        b.find_ontology_conflicts(&query(json!({ "sourceIds": ["alt"] })))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.find_ontology_conflicts(&query(json!({ "visibility": ["world"] })))
            .unwrap()
            .is_empty()
    );
    let alt = b
        .get_ontology(&query(json!({ "sourceIds": ["alt"] })))
        .unwrap();
    assert_eq!(values(&alt), vec![("role", "advisor")]);
    let both = b.discover_ontology_dimensions(&query(json!({}))).unwrap();
    assert_eq!(
        both,
        vec![json!({ "dimension": "role", "entities": 1, "observations": 2 })]
    );
}

#[test]
fn a_same_stint_key_is_a_noop_and_a_backdated_repeat_is_stored_live() {
    let b = brain("ontology-stint");
    merge(&b, json!({ "validFrom": "2026-01-01T00:00:00.000Z" }));
    merge(
        &b,
        json!({ "value": "advisor", "source": "meetings/b", "validFrom": "2026-05-01T00:00:00.000Z" }),
    );
    // Founder again, before the advisor stint: an earlier stint, stored live without closing anything.
    let back = merge(
        &b,
        json!({ "source": "meetings/c", "validFrom": "2025-01-01T00:00:00.000Z" }),
    );
    assert_eq!(
        back,
        json!({ "action": "inserted", "factId": 3, "supersededId": null })
    );
    // The first founder row's exact stint key: nothing new is stored.
    let again = merge(&b, json!({ "validFrom": "2026-01-01T00:00:00.000Z" }));
    assert_eq!(again["action"], "noop");
    let dup = merge(
        &b,
        json!({ "source": "meetings/c", "validFrom": "2025-01-01T00:00:00.000Z" }),
    );
    assert_eq!(dup["action"], "noop");
    let at = b
        .get_ontology(&query(json!({ "asof": "2025-06-01T00:00:00.000Z" })))
        .unwrap();
    assert_eq!(at[0]["source"], "meetings/c");
}

#[test]
fn a_confidence_floor_is_compared_as_the_stored_real() {
    let b = brain("ontology-floor-real");
    merge(&b, json!({ "confidence": 0.7 }));
    let rows = b
        .get_ontology(&query(json!({ "minConfidence": 0.7 })))
        .unwrap();
    assert_eq!(values(&rows), [("role", "founder")], "{rows:?}");
    let rows = b
        .get_ontology(&query(json!({ "minConfidence": 0.71 })))
        .unwrap();
    assert!(rows.is_empty(), "{rows:?}");
}
