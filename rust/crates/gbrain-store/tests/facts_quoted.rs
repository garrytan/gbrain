//! The quote and slot-history reads of `facts/quoted.rs`, each against the rows its PGLite statement returns
//! (src/core/engine-sql/facts-recall.ts).

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::quoted::{QuotedFactsQuery, ReadablePageSlugsQuery, TrustFloorQuery};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn args<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Puts `slug` into `source` with `page_type`; resolves the page id.
fn page(b: &Brain, source: &str, slug: &str, page_type: &str, frontmatter: Value) -> u64 {
    let input: PageInput = args(json!({
        "type": page_type, "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    b.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn source(b: &Brain, id: &str) {
    let input: SourceInput = args(json!({ "id": id, "name": id, "config": {} }));
    b.upsert_source(&input).unwrap();
}

/// Inserts one fact into `source` under write tier `tier` (None: no declared tier, stamped `unknown`).
fn fact(b: &Brain, source: &str, tier: Option<&str>, row: Value) -> u64 {
    let tx = b.begin_transaction(false).unwrap();
    if let Some(tier) = tier {
        let names = [
            "gbrain.write_trust_tier",
            "gbrain.write_trust_promotion",
            "gbrain.write_origin",
        ]
        .map(String::from);
        tx.apply_write_trust(&names, &[tier.into(), tier.into(), json!({}).to_string()])
            .unwrap();
    }
    let mut base = json!({ "fact": "f", "entity_slug": "people/a", "kind": "fact", "source": "t" });
    base.as_object_mut()
        .unwrap()
        .extend(row.as_object().unwrap().clone());
    let out = tx
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [base], "sourceId": source }),
        ))
        .unwrap();
    tx.commit_transaction().unwrap();
    b.clock.advance(1);
    out["ids"][0].as_u64().unwrap()
}

fn as_i64(ids: &[u64]) -> Vec<i64> {
    ids.iter().map(|id| *id as i64).collect()
}

#[test]
fn quoted_facts_name_a_typed_page_by_slug_or_backstop_session_in_their_own_source() {
    let b = brain("quoted-facts");
    source(&b, "other");
    page(&b, "default", "chats/a", "conversation", json!({}));
    page(&b, "default", "chats/gone", "conversation", json!({}));
    page(&b, "default", "notes/n", "note", json!({}));
    b.soft_delete_page("chats/gone", Some("default")).unwrap();

    let by_slug = fact(
        &b,
        "default",
        None,
        json!({ "source_markdown_slug": "chats/a" }),
    );
    let deleted_page = fact(
        &b,
        "default",
        None,
        json!({ "source_markdown_slug": "chats/gone" }),
    );
    let note = fact(
        &b,
        "default",
        None,
        json!({ "source_markdown_slug": "notes/n" }),
    );
    let synced = fact(
        &b,
        "default",
        None,
        json!({ "source": "sync:import", "source_session": "sync:chats/a" }),
    );
    let put = fact(
        &b,
        "default",
        None,
        json!({ "source": "mcp:put_page", "source_session": "put_page:chats/a" }),
    );
    let crossed = fact(
        &b,
        "default",
        None,
        json!({ "source": "sync:import", "source_session": "put_page:chats/a" }),
    );
    let note_session = fact(
        &b,
        "default",
        None,
        json!({ "source": "sync:import", "source_session": "sync:notes/n" }),
    );
    let other_source = fact(
        &b,
        "other",
        None,
        json!({ "source": "sync:import", "source_session": "sync:chats/a" }),
    );
    let plain = fact(&b, "default", None, json!({}));

    let all = [
        by_slug,
        deleted_page,
        note,
        synced,
        put,
        crossed,
        note_session,
        other_source,
        plain,
    ];
    let mut ids = as_i64(&all);
    ids.extend([by_slug as i64, -1, 999_999]);
    let q: QuotedFactsQuery = args(json!({
        "ids": ids, "pageTypes": ["conversation"],
        "backstopSessions": [["sync:import", "sync:"], ["mcp:put_page", "put_page:"]],
    }));
    assert_eq!(
        b.list_facts_from_quoted_pages(&q).unwrap(),
        [by_slug, deleted_page, synced, put]
    );

    let none: QuotedFactsQuery =
        args(json!({ "ids": [], "pageTypes": ["conversation"], "backstopSessions": [] }));
    assert!(b.list_facts_from_quoted_pages(&none).unwrap().is_empty());
    let no_sessions: QuotedFactsQuery = args(json!({
        "ids": as_i64(&all), "pageTypes": ["conversation", "note"], "backstopSessions": [] }));
    assert_eq!(
        b.list_facts_from_quoted_pages(&no_sessions).unwrap(),
        [by_slug, deleted_page, note]
    );
}

#[test]
fn trust_floor_keeps_facts_whose_stored_tier_ranks_at_or_above_it() {
    let b = brain("quoted-trust-floor");
    let confirmed = fact(&b, "default", Some("user_confirmed"), json!({}));
    let curated = fact(&b, "default", Some("operator_curated"), json!({}));
    let agent = fact(&b, "default", Some("agent_written"), json!({}));
    let unknown = fact(&b, "default", None, json!({}));
    let ids = as_i64(&[confirmed, curated, agent, unknown, 999_999]);
    let q = |floor: &str| -> TrustFloorQuery { args(json!({ "ids": ids, "floor": floor })) };
    assert_eq!(
        b.list_fact_ids_at_trust_floor(&q("operator_curated"))
            .unwrap(),
        [confirmed, curated]
    );
    assert_eq!(
        b.list_fact_ids_at_trust_floor(&q("unknown")).unwrap(),
        [confirmed, curated, agent, unknown]
    );
    assert_eq!(
        b.list_fact_ids_at_trust_floor(&q("user_confirmed"))
            .unwrap(),
        [confirmed]
    );
    assert!(b.list_fact_ids_at_trust_floor(&q("not-a-tier")).is_err());
}

#[test]
fn page_types_by_id_include_deleted_pages_and_skip_missing_ids() {
    let b = brain("quoted-page-types");
    let chat = page(&b, "default", "chats/a", "conversation", json!({}));
    let gone = page(&b, "default", "notes/gone", "note", json!({}));
    b.soft_delete_page("notes/gone", Some("default")).unwrap();
    let rows = b
        .read_page_types_by_ids(&[chat as i64, gone as i64, chat as i64, -1, 999_999])
        .unwrap();
    let mut rows: Vec<(u64, String)> = rows
        .iter()
        .map(|r| {
            (
                r["id"].as_u64().unwrap(),
                r["type"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    rows.sort();
    assert_eq!(
        rows,
        [
            (chat, "conversation".to_string()),
            (gone, "note".to_string())
        ]
    );
}

#[test]
fn readable_page_slugs_apply_the_live_page_policy_in_the_asked_source() {
    let b = brain("quoted-readable-slugs");
    source(&b, "other");
    page(&b, "default", "people/a", "person", json!({}));
    page(&b, "default", "people/b", "person", json!({}));
    page(&b, "default", "people/gone", "person", json!({}));
    page(
        &b,
        "default",
        "people/held",
        "person",
        json!({ "quarantine": "x" }),
    );
    page(&b, "other", "people/c", "person", json!({}));
    b.soft_delete_page("people/gone", Some("default")).unwrap();
    let q = |slugs: Value, scope: Value, limit: u32| -> ReadablePageSlugsQuery {
        args(json!({ "sourceId": "default", "slugs": slugs, "scope": scope, "limit": limit }))
    };
    let asked = json!([
        "people/gone",
        "people/held",
        "people/c",
        "people/b",
        "people/a",
        "people/b"
    ]);
    assert_eq!(
        b.list_readable_page_slugs(&q(asked.clone(), json!({}), 10))
            .unwrap(),
        ["people/b", "people/a"]
    );
    assert_eq!(
        b.list_readable_page_slugs(&q(asked.clone(), json!({}), 1))
            .unwrap(),
        ["people/b"]
    );
    // The scope's own sources do not narrow the read: the source is `sourceId`.
    assert_eq!(
        b.list_readable_page_slugs(&q(
            asked,
            json!({ "sourceId": "other", "sourceIds": ["other"] }),
            10
        ))
        .unwrap(),
        ["people/b", "people/a"]
    );
    assert!(
        b.list_readable_page_slugs(&q(
            json!(["people/a"]),
            json!({ "minTrust": "operator_curated" }),
            10
        ))
        .unwrap()
        .is_empty()
    );
}

/// Records `inputs` (table, id) as the derivation inputs of fact `fact_id` in `source`.
fn derived_from(b: &Brain, source: &str, fact_id: u64, inputs: &[(&str, &str)]) {
    let inputs: Vec<Value> = inputs
        .iter()
        .map(|(table, id)| json!({ "table": table, "id": id }))
        .collect();
    let a: gbrain_store::generations::DerivationInputsArgs = args(json!({
        "derived": { "table": "facts", "id": fact_id.to_string() },
        "sourceId": source,
        "inputs": inputs,
    }));
    b.record_derivation_inputs(&a).unwrap();
}

/// The derivation clause of the SQL: a `derivation_inputs` edge from the fact to a page of one of the types counts,
/// whatever source the page is in and deleted or not. An input that is no page, an id that is not 1 to 18 digits, or a
/// page of another type does not count.
#[test]
fn quoted_facts_follow_a_derivation_input_edge_to_a_typed_page() {
    let b = brain("quoted-derived");
    source(&b, "other");
    let chat = page(&b, "default", "chats/a", "conversation", json!({}));
    let gone = page(&b, "default", "chats/gone", "conversation", json!({}));
    let elsewhere = page(&b, "other", "chats/x", "conversation", json!({}));
    let note = page(&b, "default", "notes/n", "note", json!({}));
    b.soft_delete_page("chats/gone", Some("default")).unwrap();

    let derived = fact(&b, "default", None, json!({}));
    let from_deleted = fact(&b, "default", None, json!({}));
    let from_other_source = fact(&b, "default", None, json!({}));
    let padded = fact(&b, "default", None, json!({}));
    let from_note = fact(&b, "default", None, json!({}));
    let not_a_page = fact(&b, "default", None, json!({}));
    let not_digits = fact(&b, "default", None, json!({}));
    let too_long = fact(&b, "default", None, json!({}));
    let plain = fact(&b, "default", None, json!({}));

    derived_from(&b, "default", derived, &[("pages", &chat.to_string())]);
    derived_from(&b, "default", from_deleted, &[("pages", &gone.to_string())]);
    derived_from(
        &b,
        "default",
        from_other_source,
        &[("pages", &elsewhere.to_string())],
    );
    derived_from(&b, "default", padded, &[("pages", &format!("00{chat}"))]);
    derived_from(&b, "default", from_note, &[("pages", &note.to_string())]);
    derived_from(&b, "default", not_a_page, &[("facts", &chat.to_string())]);
    derived_from(&b, "default", not_digits, &[("pages", &format!("{chat}a"))]);
    derived_from(
        &b,
        "default",
        too_long,
        &[("pages", &format!("{:019}", chat))],
    );

    let all = [
        derived,
        from_deleted,
        from_other_source,
        padded,
        from_note,
        not_a_page,
        not_digits,
        too_long,
        plain,
    ];
    let q: QuotedFactsQuery = args(json!({
        "ids": as_i64(&all),
        "pageTypes": ["conversation"],
        "backstopSessions": [["sync:import", "sync:"], ["mcp:put_page", "put_page:"]],
    }));
    let mut want = vec![derived, from_deleted, from_other_source, padded];
    want.sort_unstable();
    assert_eq!(b.list_facts_from_quoted_pages(&q).unwrap(), want);
}
