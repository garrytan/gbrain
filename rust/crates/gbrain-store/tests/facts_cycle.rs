//! Group 5 facts reads: the command, cycle and fence reads of `facts/cycle.rs`, each against the rows its
//! PGLite statement returns (src/core/engine-sql/facts-cycle.ts).

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::cycle::{
    BucketQuery, BulkDayQuery, EntityFactsQuery, ExtractionOutcomeQuery, PageCoordinate,
    WorldFactCount,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, T0, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn args<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str, source: &str, frontmatter: Value) {
    let input: PageInput = args(
        json!({ "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }),
    );
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    b.put_page(slug, &input, &options).unwrap();
}

fn source(b: &Brain, id: &str, local_path: Option<&str>) {
    let input: SourceInput =
        args(json!({ "id": id, "name": id, "local_path": local_path, "config": {} }));
    b.upsert_source(&input).unwrap();
}

/// Inserts `rows` into `source` (a row with no `source` tag gets `t`, the column is NOT NULL); none is skipped.
fn insert(b: &Brain, source: &str, mut rows: Value) -> Vec<u64> {
    for row in rows.as_array_mut().unwrap() {
        row["source"] = row.get("source").cloned().unwrap_or(json!("t"));
    }
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": source }),
        ))
        .unwrap();
    out["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect()
}

fn coordinate(source: &str, slug: &str) -> PageCoordinate {
    args(json!({ "sourceId": source, "slug": slug }))
}

#[test]
fn active_facts_for_entity_order_by_confidence_then_newest_id() {
    let b = brain("cycle-entity");
    insert(
        &b,
        "default",
        json!([
            { "fact": "low", "entity_slug": "people/a", "source": "s", "confidence": 0.2 },
            { "fact": "high-old", "entity_slug": "people/a", "source": "s", "confidence": 0.9, "context": "ctx" },
            { "fact": "high-new", "entity_slug": "people/a", "source": "s", "confidence": 0.9 },
            { "fact": "lapsed", "entity_slug": "people/a", "source": "s", "confidence": 1.0, "valid_until": iso(T0 - DAY) },
            { "fact": "expired", "entity_slug": "people/a", "source": "s", "confidence": 1.0, "expired_at": iso(T0 - DAY) },
            { "fact": "other", "entity_slug": "people/b", "source": "s", "confidence": 1.0 },
        ]),
    );
    let q = |limit: f64| -> EntityFactsQuery {
        args(json!({ "sourceId": "default", "entitySlug": "people/a", "limit": limit }))
    };
    let rows = b.list_active_facts_for_entity(&q(10.0)).unwrap();
    let facts: Vec<&str> = rows.iter().map(|r| r["fact"].as_str().unwrap()).collect();
    assert_eq!(facts, ["high-new", "high-old", "low"]);
    assert_eq!(rows[1]["context"], json!("ctx"));
    assert_eq!(rows[0]["context"], Value::Null);
    assert_eq!(b.list_active_facts_for_entity(&q(2.0)).unwrap().len(), 2);
    assert!(b.list_active_facts_for_entity(&q(-1.0)).is_err());
}

#[test]
fn fresh_extraction_outcomes_list_the_preferred_source_first_per_slug() {
    let b = brain("cycle-outcomes");
    for slug in ["chat/a", "chat/b"] {
        page(&b, slug, "default", json!({}));
    }
    insert(
        &b,
        "default",
        json!([
            { "fact": "x", "source": "audit:other", "source_session": "s1", "source_markdown_slug": "chat/b" },
            { "fact": "x", "source": "audit:terminal", "source_session": "s2", "source_markdown_slug": "chat/b" },
            { "fact": "x", "source": "audit:other", "source_session": "s3", "source_markdown_slug": "chat/a" },
            { "fact": "x", "source": "audit:other", "source_session": "gone", "source_markdown_slug": "chat/a",
              "expired_at": iso(T0 - DAY) },
            { "fact": "x", "source": "chat", "source_session": "ignored", "source_markdown_slug": "chat/a" },
        ]),
    );
    let q: ExtractionOutcomeQuery = args(json!({
        "sourceId": "default", "slugs": ["chat/b", "chat/a", "chat/a", "chat/none"],
        "sources": ["audit:terminal", "audit:other"], "preferredSource": "audit:terminal",
    }));
    let rows = b.list_fresh_extraction_outcomes(&q).unwrap();
    let got: Vec<(&str, &str)> = rows
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap(),
                r["source_session"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(got, [("chat/a", "s3"), ("chat/b", "s2"), ("chat/b", "s1")]);
}

#[test]
fn fence_row_groups_collect_numbers_and_expiry_and_skip_conversation_rows() {
    let b = brain("cycle-groups");
    insert(
        &b,
        "default",
        json!([
            { "fact": "a3", "source": "fence", "row_num": 3, "source_markdown_slug": "n/a" },
            { "fact": "a1", "source": "fence", "row_num": 1, "source_markdown_slug": "n/a" },
            { "fact": "b1", "source": "fence", "row_num": 1, "source_markdown_slug": "n/b", "expired_at": iso(T0 - DAY) },
            { "fact": "b2", "source": "fence", "row_num": 2, "source_markdown_slug": "n/b", "expired_at": iso(T0 - DAY) },
            { "fact": "c1", "source": "cli:extract-conversation-facts", "row_num": 1, "source_markdown_slug": "n/c" },
            { "fact": "d", "source": "fence", "source_markdown_slug": "n/d" },
        ]),
    );
    let groups = b.list_fence_row_groups().unwrap();
    assert_eq!(
        groups,
        [
            json!({ "source_id": "default", "source_markdown_slug": "n/a", "row_nums": [1, 3], "all_expired": false }),
            json!({ "source_id": "default", "source_markdown_slug": "n/b", "row_nums": [1, 2], "all_expired": true }),
        ]
    );
}

#[test]
fn fact_subject_is_the_page_else_the_entity() {
    let b = brain("cycle-subject");
    let ids = insert(
        &b,
        "default",
        json!([
            { "fact": "on a page", "entity_slug": "people/a", "source_markdown_slug": "n/p", "row_num": 1 },
            { "fact": "entity only", "entity_slug": "people/a" },
            { "fact": "neither" },
        ]),
    );
    let subject = |id: u64| b.read_fact_subject(id as f64).unwrap();
    assert_eq!(
        subject(ids[0]),
        json!({ "source_id": "default", "slug": "n/p" })
    );
    assert_eq!(
        subject(ids[1]),
        json!({ "source_id": "default", "slug": "people/a" })
    );
    assert_eq!(
        subject(ids[2]),
        json!({ "source_id": "default", "slug": null })
    );
    assert_eq!(subject(999), Value::Null);
    assert_eq!(subject(0), Value::Null);
    assert!(b.read_fact_subject(1.5).is_err());
}

#[test]
fn facts_for_page_skip_conversation_and_soft_expired_legacy_rows() {
    let b = brain("cycle-page-facts");
    insert(
        &b,
        "default",
        json!([
            { "fact": "r2", "source": "fence", "row_num": 2, "source_markdown_slug": "n/a", "confidence": 0.8,
              "claim_metric": "arr", "claim_value": 1.5, "valid_from": "2026-01-01T00:00:00.000Z", "embedding": null },
            { "fact": "legacy", "source": "fence", "source_markdown_slug": "n/a" },
            { "fact": "legacy gone", "source": "fence", "source_markdown_slug": "n/a", "expired_at": iso(T0 - DAY) },
            { "fact": "chat", "source": "cli:extract-conversation-facts", "row_num": 7, "source_markdown_slug": "n/a" },
            { "fact": "r1 expired", "source": "fence", "row_num": 1, "source_markdown_slug": "n/a", "expired_at": iso(T0 - DAY) },
            { "fact": "elsewhere", "source": "fence", "row_num": 1, "source_markdown_slug": "n/b" },
        ]),
    );
    let rows = b
        .list_facts_for_page(&coordinate("default", "n/a"))
        .unwrap();
    let facts: Vec<&str> = rows.iter().map(|r| r["fact"].as_str().unwrap()).collect();
    assert_eq!(facts, ["r1 expired", "r2", "legacy"]);
    assert_eq!(rows[0]["expired_at"], json!(iso(T0 - DAY)));
    assert_eq!(rows[1]["confidence"], json!(0.8));
    assert_eq!(rows[1]["claim_value"], json!(1.5));
    assert_eq!(rows[1]["valid_from"], json!("2026-01-01T00:00:00.000000Z"));
    assert_eq!(rows[1]["has_embedding"], json!(false));
    assert_eq!(rows[2]["row_num"], Value::Null);
    assert!(
        b.list_facts_for_page(&coordinate("default", "n/none"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn legacy_pending_counts_unfenced_rows_of_live_entity_pages_in_a_checkout() {
    let b = brain("cycle-legacy");
    source(&b, "repo", Some("/srv/repo"));
    source(&b, "dbonly", None);
    for (src, slug) in [
        ("repo", "people/a"),
        ("repo", "people/gone"),
        ("dbonly", "people/a"),
    ] {
        page(&b, slug, src, json!({}));
    }
    b.soft_delete_page("people/gone", Some("repo")).unwrap();
    insert(
        &b,
        "repo",
        json!([
            { "fact": "1", "entity_slug": "people/a" },
            { "fact": "2", "entity_slug": "people/a" },
            { "fact": "fenced", "entity_slug": "people/a", "row_num": 1, "source_markdown_slug": "people/a" },
            { "fact": "observed", "entity_slug": "people/a", "dimension": "role", "value": "cto" },
            { "fact": "expired", "entity_slug": "people/a", "expired_at": iso(T0 - DAY) },
            { "fact": "no page", "entity_slug": "people/missing" },
            { "fact": "deleted", "entity_slug": "people/gone" },
            { "fact": "no entity" },
        ]),
    );
    insert(
        &b,
        "dbonly",
        json!([{ "fact": "no checkout", "entity_slug": "people/a" }]),
    );
    assert_eq!(
        b.count_legacy_facts_pending("repo").unwrap(),
        [json!({ "entity_slug": "people/a", "n": 2 })]
    );
    assert!(b.count_legacy_facts_pending("dbonly").unwrap().is_empty());
    assert!(b.count_legacy_facts_pending("none").unwrap().is_empty());
}

#[test]
fn unconsolidated_buckets_apply_the_page_attribution_visibility_and_readers_rules() {
    let b = brain("cycle-buckets");
    for slug in [
        "people/a",
        "people/b",
        "people/gone",
        "src/readers",
        "src/open",
    ] {
        page(
            &b,
            slug,
            "default",
            if slug == "src/readers" {
                json!({ "readable_by": ["x"] })
            } else {
                json!({})
            },
        );
    }
    b.soft_delete_page("people/gone", None).unwrap();
    insert(
        &b,
        "default",
        json!([
            { "fact": "a1", "entity_slug": "people/a", "visibility": "world" },
            { "fact": "a2", "entity_slug": "people/a", "visibility": "private", "attributed_to": "user" },
            { "fact": "a3", "entity_slug": "people/a", "visibility": "world", "attributed_to": "assistant" },
            { "fact": "a4", "entity_slug": "people/a", "visibility": "world", "valid_until": iso(T0 - DAY) },
            { "fact": "a5", "entity_slug": "people/a", "visibility": "world", "expired_at": iso(T0 - DAY) },
            { "fact": "a6", "entity_slug": "people/a", "visibility": "world", "source_markdown_slug": "src/readers", "row_num": 1 },
            { "fact": "a7", "entity_slug": "people/a", "visibility": "world", "source_markdown_slug": "src/open", "row_num": 1 },
            { "fact": "b1", "entity_slug": "people/b", "visibility": "world" },
            { "fact": "g1", "entity_slug": "people/gone", "visibility": "world" },
            { "fact": "g2", "entity_slug": "people/gone", "visibility": "world" },
            { "fact": "n1", "entity_slug": "people/nopage", "visibility": "world" },
        ]),
    );
    let q = |source: Option<&str>, world: bool, least: f64| -> BucketQuery {
        args(json!({ "sourceId": source, "worldOnly": world, "minPerBucket": least }))
    };
    let count = |q: &BucketQuery| -> Vec<(String, i64)> {
        b.count_unconsolidated_facts_by_source(q)
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["entity_slug"].as_str().unwrap().to_string(),
                    r["count"].as_i64().unwrap(),
                )
            })
            .collect()
    };
    assert_eq!(
        count(&q(None, false, 1.0)),
        [("people/a".to_string(), 3), ("people/b".to_string(), 1)]
    );
    assert_eq!(
        count(&q(None, true, 1.0)),
        [("people/a".to_string(), 2), ("people/b".to_string(), 1)]
    );
    assert_eq!(
        count(&q(Some("default"), false, 2.0)),
        [("people/a".to_string(), 3)]
    );
    assert!(count(&q(Some("other"), false, 1.0)).is_empty());
}

#[test]
fn bulk_days_apply_the_thresholds_top_sources_and_dated_claims() {
    let b = brain("cycle-bulk");
    source(&b, "arch", None);
    let day = "2026-03-10T09:00:00.000Z";
    let mut rows = Vec::new();
    for i in 0..6 {
        let (source, fact) = match i {
            0 => ("s2", "plain".to_string()),
            1 => ("s1", "since 2026-01-05 it grew".to_string()),
            2 => ("s1", "2024-02-30 is no date".to_string()),
            3 => ("s1", "2026-03-10 is the day itself".to_string()),
            4 => ("s1", "between 2025-12-01 and 2025-12-02".to_string()),
            _ => ("s3", "see 1899-12-31 or v2025-12-0123".to_string()),
        };
        rows.push(json!({ "fact": fact, "entity_slug": format!("e/{}", i % 3), "source": source, "valid_from": day }));
    }
    rows.push(json!({ "fact": "other day", "entity_slug": "e/9", "source": "s1", "valid_from": "2026-03-11T00:00:00.000Z" }));
    insert(&b, "default", Value::Array(rows));
    insert(
        &b,
        "arch",
        json!([{ "fact": "x", "entity_slug": "e/1", "source": "s1", "valid_from": day }]),
    );
    b.set_source_archived("arch", true).unwrap();
    let q = |ids: Option<Vec<&str>>, facts: f64, share: f64, entities: f64| -> BulkDayQuery {
        args(
            json!({ "sourceIds": ids, "rule": { "minFacts": facts, "minShare": share, "minEntities": entities } }),
        )
    };
    let days = b.find_bulk_fact_days(&q(None, 6.0, 0.5, 3.0)).unwrap();
    assert_eq!(
        days,
        [json!({
            "source_id": "default", "day": "2026-03-10", "facts": 6, "entities": 3, "source_facts": 7,
            "top_sources": [{ "source": "s1", "facts": 4 }, { "source": "s2", "facts": 1 }, { "source": "s3", "facts": 1 }],
            "dated_claims": 1,
        })]
    );
    for (rule, why) in [
        (q(None, 7.0, 0.5, 3.0), "min_facts"),
        (q(None, 6.0, 0.9, 3.0), "min_share"),
        (q(None, 6.0, 0.5, 4.0), "min_entities"),
        (q(Some(vec![]), 6.0, 0.5, 3.0), "no sources"),
        (q(Some(vec!["arch"]), 1.0, 0.1, 1.0), "archived"),
    ] {
        assert!(b.find_bulk_fact_days(&rule).unwrap().is_empty(), "{why}");
    }
    assert!(
        !b.find_bulk_fact_days(&q(Some(vec!["default"]), 1.0, 0.1, 1.0))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn fence_row_numbers_and_stored_rows_follow_the_page_coordinate() {
    let b = brain("cycle-fence");
    insert(
        &b,
        "default",
        json!([
            { "fact": "second", "row_num": 5, "source_markdown_slug": "n/a" },
            { "fact": "first", "row_num": 2, "source_markdown_slug": "n/a" },
            { "fact": "unfenced", "source_markdown_slug": "n/a" },
            { "fact": "other", "row_num": 9, "source_markdown_slug": "n/b" },
        ]),
    );
    assert_eq!(
        b.max_fence_row_num(&coordinate("default", "n/a")).unwrap(),
        5
    );
    assert_eq!(
        b.max_fence_row_num(&coordinate("default", "n/none"))
            .unwrap(),
        0
    );
    assert_eq!(b.max_fence_row_num(&coordinate("other", "n/a")).unwrap(), 0);
    assert_eq!(
        b.list_stored_fence_fact_rows(&coordinate("default", "n/a"))
            .unwrap(),
        [
            json!({ "row_num": 5, "fact": "second" }),
            json!({ "row_num": 2, "fact": "first" }),
        ]
    );
}

#[test]
fn world_fact_count_hides_deleted_and_quarantined_pages_but_not_lapsed_rows() {
    let b = brain("cycle-count");
    page(&b, "people/a", "default", json!({}));
    page(&b, "people/q", "default", json!({}));
    page(&b, "people/d", "default", json!({}));
    page(
        &b,
        "n/quarantined",
        "default",
        json!({ "quarantine": { "reason": "x" } }),
    );
    b.soft_delete_page("people/d", None).unwrap();
    insert(
        &b,
        "default",
        json!([
            { "fact": "w", "entity_slug": "people/a", "visibility": "world" },
            { "fact": "p", "entity_slug": "people/a", "visibility": "private" },
            { "fact": "lapsed", "entity_slug": "people/a", "visibility": "world", "valid_until": iso(T0 - DAY) },
            { "fact": "expired", "entity_slug": "people/a", "visibility": "world", "expired_at": iso(T0 - DAY) },
            { "fact": "q", "entity_slug": "people/q", "visibility": "world", "source_markdown_slug": "n/quarantined", "row_num": 1 },
            { "fact": "d", "entity_slug": "people/d", "visibility": "world" },
            { "fact": "no page", "entity_slug": "people/none", "visibility": "world" },
        ]),
    );
    let q = |slugs: Value, world: bool| -> WorldFactCount {
        args(json!({ "sourceId": "default", "entitySlugs": slugs, "worldOnly": world }))
    };
    assert_eq!(
        b.count_world_facts(&q(json!(["people/a"]), false)).unwrap(),
        3
    );
    assert_eq!(
        b.count_world_facts(&q(json!(["people/a", "people/a"]), true))
            .unwrap(),
        2
    );
    assert_eq!(
        b.count_world_facts(&q(
            json!(["people/a", "people/q", "people/d", "people/none"]),
            false
        ))
        .unwrap(),
        4
    );
    assert_eq!(b.count_world_facts(&q(json!([]), false)).unwrap(), 0);
}
