//! Typed trust tier reads (`trust/tier_reads.rs`): the core page list, the trust scan rows and
//! counts, and the version tier reads.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::sources::SourceInput;
use gbrain_store::trust::tier_reads::{
    CorePageRowQuery, PageIdsQuery, TrustScanQuery, VersionIdsQuery,
};
use gbrain_store::trust::write_gate::ReceiptFields;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Opens a transaction under a declared tier (none for `None`) and runs `f` in it.
fn declared(b: &Brain, tier: Option<&str>, f: impl FnOnce(&gbrain_store::Store)) {
    let tx = b.begin_transaction(false).unwrap();
    if let Some(tier) = tier {
        let names = [
            "gbrain.write_trust_tier",
            "gbrain.write_trust_promotion",
            "gbrain.write_origin",
        ]
        .map(String::from);
        let origin = json!({ "channel": tier }).to_string();
        tx.apply_write_trust(&names, &[tier.into(), tier.into(), origin])
            .unwrap();
    }
    f(&tx);
    tx.commit_transaction().unwrap();
}

fn page(
    b: &Brain,
    source: &str,
    slug: &str,
    tier: Option<&str>,
    page_type: &str,
    frontmatter: Value,
) {
    declared(b, tier, |tx| {
        let input: gbrain_store::pages::PageInput = args(json!({
            "type": page_type, "title": format!("T {slug}"), "compiled_truth": format!("body {slug}"),
            "timeline": "", "frontmatter": frontmatter }));
        tx.put_page(slug, &input, &args(json!({ "sourceId": source })))
            .unwrap();
    });
}

fn core(b: &Brain, source: &str, slug: &str, tier: Option<&str>, extra: Value) {
    let mut fm = json!({ "always_load": true });
    for (k, v) in extra.as_object().unwrap() {
        fm[k] = v.clone();
    }
    page(b, source, slug, tier, "note", fm);
}

fn flag(b: &Brain, slug: &str) {
    let fields = ReceiptFields {
        content_hash: "h1".into(),
        tier: "agent_written".into(),
        detector_version: 1,
        verdict: "flag".into(),
        reason_families: vec!["override".into()],
        reasons: vec!["override found".into()],
        detector_error: false,
        request_id: None,
    };
    assert!(
        b.upsert_page_write_gate_receipt("default", slug, fields)
            .unwrap()
            .is_some()
    );
}

fn other_source(b: &Brain) {
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
}

fn seed_core(b: &Brain) {
    other_source(b);
    core(
        b,
        "default",
        "core/curated",
        Some("operator_curated"),
        json!({}),
    );
    core(b, "default", "core/agent", Some("agent_written"), json!({}));
    core(
        b,
        "default",
        "core/flagged",
        Some("agent_written"),
        json!({}),
    );
    flag(b, "core/flagged");
    core(b, "default", "core/unknown", None, json!({}));
    core(
        b,
        "default",
        "core/private",
        Some("operator_curated"),
        json!({ "visibility": "private" }),
    );
    core(
        b,
        "default",
        "core/quarantined",
        Some("operator_curated"),
        json!({ "quarantine": { "reason": "t" } }),
    );
    core(
        b,
        "default",
        "core/withdrawn",
        Some("tool_observed"),
        json!({}),
    );
    page(
        b,
        "default",
        "notes/plain",
        Some("operator_curated"),
        "note",
        json!({ "always_load": false }),
    );
    core(
        b,
        "default",
        "core/deleted",
        Some("operator_curated"),
        json!({}),
    );
    b.soft_delete_page("core/deleted", Some("default")).unwrap();
    core(
        b,
        "other",
        "core/elsewhere",
        Some("tool_observed"),
        json!({}),
    );
    b.insert_fact_withdrawal("default", "world", "a claim", "core/withdrawn", None)
        .unwrap();
}

#[test]
fn a_source_wide_withdrawal_marks_every_core_page_of_that_source() {
    let b = brain("tier-reads-core-star");
    other_source(&b);
    core(&b, "default", "core/a", None, json!({}));
    core(&b, "other", "core/b", None, json!({}));
    core(&b, "other", "core/c", None, json!({}));
    b.insert_fact_withdrawal("other", "world", "a claim", "*", None)
        .unwrap();
    let rows = core_rows(&b, json!({}));
    let marks: Vec<(String, bool)> = rows
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap().to_owned(),
                r["withdrawn"] == json!(true),
            )
        })
        .collect();
    assert_eq!(
        marks,
        [
            ("core/a".to_owned(), false),
            ("core/b".to_owned(), true),
            ("core/c".to_owned(), true)
        ]
    );
}

fn core_rows(b: &Brain, q: Value) -> Vec<Value> {
    let mut spec = json!({ "sourceIds": null, "exclude": null, "excludePrivate": null, "eligible": false,
        "minTrust": null, "suppressFlagged": false, "limit": 50 });
    for (k, v) in q.as_object().unwrap() {
        spec[k] = v.clone();
    }
    b.list_core_page_rows(&args::<CorePageRowQuery>(spec))
        .unwrap()
}

fn keys(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| {
            format!(
                "{}:{}",
                r["source_id"].as_str().unwrap(),
                r["slug"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn core_rows_list_the_live_always_load_pages_by_source_then_slug() {
    let b = brain("tier-reads-core-all");
    seed_core(&b);
    let all = core_rows(&b, json!({}));
    assert_eq!(
        keys(&all),
        [
            "default:core/agent",
            "default:core/curated",
            "default:core/flagged",
            "default:core/private",
            "default:core/quarantined",
            "default:core/unknown",
            "default:core/withdrawn",
            "other:core/elsewhere",
        ]
    );
    let withdrawn: Vec<&str> = all
        .iter()
        .filter(|r| r["withdrawn"] == json!(true))
        .map(|r| r["slug"].as_str().unwrap())
        .collect();
    assert_eq!(withdrawn, ["core/withdrawn"]);
    assert_eq!(all[0]["title"], json!("T core/agent"));
    assert_eq!(all[0]["compiled_truth"], json!("body core/agent"));
    assert_eq!(all[0]["segmented"], json!(false));
    assert_eq!(all[0]["body_bytes"], Value::Null);
    assert_eq!(all[0]["frontmatter"]["always_load"], json!(true));
    assert!(all[0].get("trust_tier").is_none());
    assert!(all[0]["id"].is_u64());

    assert_eq!(
        keys(&core_rows(&b, json!({ "limit": 2 }))),
        ["default:core/agent", "default:core/curated"]
    );
    assert_eq!(
        keys(&core_rows(&b, json!({ "sourceIds": ["other"] }))),
        ["other:core/elsewhere"]
    );
    let excluded = keys(&core_rows(
        &b,
        json!({ "exclude": { "sourceId": "default", "slug": "core/agent" } }),
    ));
    assert_eq!(excluded.len(), 7);
    assert!(!excluded.contains(&"default:core/agent".to_string()));
    // The same slug in another source is not the excluded page.
    let other = keys(&core_rows(
        &b,
        json!({ "exclude": { "sourceId": "default", "slug": "core/elsewhere" } }),
    ));
    assert!(other.contains(&"other:core/elsewhere".to_string()));
    let private = keys(&core_rows(
        &b,
        json!({ "excludePrivate": { "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" } }),
    ));
    assert_eq!(private.len(), 7);
    assert!(!private.contains(&"default:core/private".to_string()));
}

#[test]
fn eligible_core_rows_drop_quarantined_and_below_floor_pages_and_mark_flagged_ones() {
    let b = brain("tier-reads-core-eligible");
    seed_core(&b);
    let plain = core_rows(&b, json!({ "eligible": true }));
    assert!(!keys(&plain).contains(&"default:core/quarantined".to_string()));
    assert_eq!(plain.len(), 7);
    let unknown = plain
        .iter()
        .find(|r| r["slug"] == json!("core/unknown"))
        .unwrap();
    assert_eq!(unknown["trust_tier"], json!("unknown"));
    assert_eq!(unknown["write_origin"], Value::Null);
    let curated = plain
        .iter()
        .find(|r| r["slug"] == json!("core/curated"))
        .unwrap();
    assert_eq!(curated["trust_tier"], json!("operator_curated"));
    assert_eq!(
        curated["write_origin"]["channel"],
        json!("operator_curated")
    );
    assert!(plain.iter().all(|r| r["suppressed"] == json!(false)));

    let marked = core_rows(&b, json!({ "eligible": true, "suppressFlagged": true }));
    let suppressed: Vec<&str> = marked
        .iter()
        .filter(|r| r["suppressed"] == json!(true))
        .map(|r| r["slug"].as_str().unwrap())
        .collect();
    assert_eq!(suppressed, ["core/flagged"]);
    assert_eq!(marked.len(), 7);

    let floor = keys(&core_rows(
        &b,
        json!({ "eligible": true, "minTrust": "operator_curated" }),
    ));
    assert_eq!(floor, ["default:core/curated", "default:core/private"]);
    let agent = keys(&core_rows(
        &b,
        json!({ "eligible": true, "minTrust": "agent_written" }),
    ));
    assert!(agent.contains(&"default:core/agent".to_string()));
    assert!(!agent.contains(&"default:core/unknown".to_string()));
    // Without `eligible`, the floor does not filter.
    assert_eq!(
        core_rows(&b, json!({ "minTrust": "operator_curated" })).len(),
        8
    );
}

#[test]
fn core_rows_refuse_a_nul_source() {
    let b = brain("tier-reads-core-nul");
    let err = b
        .list_core_page_rows(&args::<CorePageRowQuery>(json!({ "sourceIds": ["a\u{0}"], "exclude": null,
            "excludePrivate": null, "eligible": false, "minTrust": null, "suppressFlagged": false, "limit": 1 })))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

fn scan(b: &Brain, table: &str, after: i64, limit: u64, tiers: &[&str]) -> Vec<Value> {
    b.list_trust_scan_rows(&args::<TrustScanQuery>(
        json!({ "table": table, "afterId": after, "limit": limit, "tiers": tiers }),
    ))
    .unwrap()
}

fn count(b: &Brain, table: &str, after: i64, until: Option<i64>, tiers: &[&str]) -> u64 {
    b.count_unscanned_trust_rows(&args::<TrustScanQuery>(
        json!({ "table": table, "afterId": after, "until": until, "tiers": tiers }),
    ))
    .unwrap()
}

const SCANNED: [&str; 3] = ["agent_written", "external_untrusted", "unknown"];

#[test]
fn the_trust_scan_reads_live_pages_at_a_listed_tier_above_the_cursor_in_id_order() {
    let b = brain("tier-reads-scan-pages");
    page(
        &b,
        "default",
        "scan/a",
        Some("agent_written"),
        "note",
        json!({ "k": 1 }),
    );
    page(
        &b,
        "default",
        "scan/b",
        Some("operator_curated"),
        "note",
        json!({}),
    );
    page(&b, "default", "scan/c", None, "note", json!({}));
    page(
        &b,
        "default",
        "scan/d",
        Some("external_untrusted"),
        "note",
        json!({}),
    );
    page(
        &b,
        "default",
        "scan/e",
        Some("agent_written"),
        "note",
        json!({}),
    );
    b.soft_delete_page("scan/e", Some("default")).unwrap();
    let rows = scan(&b, "pages", 0, 50, &SCANNED);
    let titles: Vec<&str> = rows.iter().map(|r| r["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["T scan/a", "T scan/c", "T scan/d"]);
    assert_eq!(rows[0]["trust_tier"], json!("agent_written"));
    assert_eq!(rows[0]["write_origin"]["channel"], json!("agent_written"));
    assert_eq!(rows[0]["frontmatter"]["k"], json!(1));
    assert_eq!(rows[0]["compiled_truth"], json!("body scan/a"));
    assert_eq!(rows[0]["timeline"], json!(""));
    assert_eq!(rows[0]["source_id"], json!("default"));
    assert_eq!(rows[1]["trust_tier"], json!("unknown"));
    let first = rows[0]["id"].as_i64().unwrap();
    let second = rows[1]["id"].as_i64().unwrap();
    assert!(first < second);
    let after = scan(&b, "pages", first, 50, &SCANNED);
    let after: Vec<&str> = after.iter().map(|r| r["title"].as_str().unwrap()).collect();
    assert_eq!(after, ["T scan/c", "T scan/d"]);
    assert_eq!(scan(&b, "pages", 0, 1, &SCANNED).len(), 1);
    assert_eq!(scan(&b, "pages", 0, 0, &SCANNED).len(), 0);
    assert_eq!(scan(&b, "pages", -5, 50, &["operator_curated"]).len(), 1);
    assert_eq!(count(&b, "pages", 0, None, &SCANNED), 3);
    assert_eq!(count(&b, "pages", first, None, &SCANNED), 2);
    assert_eq!(count(&b, "pages", 0, Some(second), &SCANNED), 2);
    assert_eq!(count(&b, "pages", 0, Some(first - 1), &SCANNED), 0);
}

#[test]
fn the_trust_scan_reads_facts_at_a_listed_tier() {
    let b = brain("tier-reads-scan-facts");
    let mut ids = Vec::new();
    for (i, (name, tier)) in [
        ("f one", Some("agent_written")),
        ("f two", Some("operator_curated")),
        ("f three", Some("external_untrusted")),
        ("f four", None),
    ]
    .into_iter()
    .enumerate()
    {
        declared(&b, tier, |tx| {
            let out = tx
                .insert_facts(&args::<InsertFactsArgs>(json!({
                    "rows": [{ "fact": name, "entity_slug": "people/a-example", "source_markdown_slug": "notes/conf",
                        "row_num": i + 1, "kind": "fact", "visibility": "world", "source": "cli",
                        "context": format!("ctx {name}") }],
                    "sourceId": "default",
                })))
                .unwrap();
            ids.push(out["ids"][0].as_i64().unwrap());
        });
    }
    let rows = scan(&b, "facts", 0, 50, &SCANNED);
    let facts: Vec<&str> = rows.iter().map(|r| r["fact"].as_str().unwrap()).collect();
    assert_eq!(facts, ["f one", "f three", "f four"]);
    assert_eq!(rows[0]["context"], json!("ctx f one"));
    assert_eq!(rows[0]["source"], json!("cli"));
    assert_eq!(rows[0]["trust_tier"], json!("agent_written"));
    assert_eq!(rows[0]["write_origin"]["channel"], json!("agent_written"));
    assert_eq!(rows[2]["trust_tier"], json!("unknown"));
    assert_eq!(count(&b, "facts", 0, None, &SCANNED), 3);
    assert_eq!(count(&b, "facts", ids[0], None, &SCANNED), 2);
    assert_eq!(count(&b, "facts", 0, Some(ids[1]), &SCANNED), 1);
}

#[test]
fn the_trust_scan_refuses_a_table_it_does_not_model_and_a_nul_tier() {
    let b = brain("tier-reads-scan-refusals");
    for table in ["takes", "timeline_entries", "links"] {
        let err = b
            .list_trust_scan_rows(&args::<TrustScanQuery>(
                json!({ "table": table, "afterId": 0, "limit": 1, "tiers": [] }),
            ))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "{table}");
        let err = b
            .count_unscanned_trust_rows(&args::<TrustScanQuery>(
                json!({ "table": table, "afterId": 0, "until": null, "tiers": [] }),
            ))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "{table}");
    }
    let err = b
        .list_trust_scan_rows(&args::<TrustScanQuery>(
            json!({ "table": "pages", "afterId": 0, "limit": 1, "tiers": ["a\u{0}"] }),
        ))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let err = b
        .list_trust_scan_rows(&args::<TrustScanQuery>(
            json!({ "table": "pages", "afterId": 0, "tiers": [] }),
        ))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

fn snapshot(b: &Brain, slug: &str) -> i64 {
    b.create_version(slug, Some("default")).unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn ids(v: &[i64]) -> VersionIdsQuery {
    args(json!({ "ids": v }))
}

#[test]
fn version_reads_answer_the_snapshot_tier_and_the_write_that_replaced_it() {
    let b = brain("tier-reads-versions");
    page(
        &b,
        "default",
        "hist/a",
        Some("agent_written"),
        "note",
        json!({}),
    );
    let a1 = snapshot(&b, "hist/a");
    page(
        &b,
        "default",
        "hist/b",
        Some("operator_curated"),
        "person",
        json!({}),
    );
    let b1 = snapshot(&b, "hist/b");
    page(
        &b,
        "default",
        "hist/a",
        Some("operator_curated"),
        "concept",
        json!({}),
    );
    let a2 = snapshot(&b, "hist/a");
    page(
        &b,
        "default",
        "hist/a",
        Some("operator_curated"),
        "project",
        json!({}),
    );
    let a3 = snapshot(&b, "hist/a");
    page(
        &b,
        "default",
        "hist/a",
        Some("operator_curated"),
        "place",
        json!({}),
    );
    page(
        &b,
        "default",
        "hist/b",
        Some("operator_curated"),
        "company",
        json!({}),
    );

    let tiers = b
        .list_version_trust_tiers(&ids(&[a2, 987_654, -1, a1, b1]))
        .unwrap();
    assert_eq!(
        tiers,
        [
            json!({ "id": a1, "trust_tier": "agent_written" }),
            json!({ "id": b1, "trust_tier": "operator_curated" }),
            json!({ "id": a2, "trust_tier": "operator_curated" }),
        ]
    );
    assert!(b.list_version_trust_tiers(&ids(&[])).unwrap().is_empty());

    let writers = b
        .list_version_reason_writers(&ids(&[a3, a2, b1, a1, 987_654]))
        .unwrap();
    assert_eq!(
        writers,
        [
            json!({ "id": a1, "type": "concept", "tier": "operator_curated" }),
            json!({ "id": b1, "type": "company", "tier": "operator_curated" }),
            json!({ "id": a2, "type": "project", "tier": "operator_curated" }),
            json!({ "id": a3, "type": "place", "tier": "operator_curated" }),
        ]
    );
    // A soft-deleted page still answers its versions.
    b.soft_delete_page("hist/b", Some("default")).unwrap();
    let writers = b.list_version_reason_writers(&ids(&[b1])).unwrap();
    assert_eq!(writers.len(), 1);
    assert_eq!(writers[0]["type"], json!("company"));
}

fn put_ref(b: &Brain, source: &str, slug: &str, page_type: &str) -> i64 {
    let input: gbrain_store::pages::PageInput = args(json!({
        "type": page_type, "title": format!("T {slug}"), "compiled_truth": format!("body {slug}"),
        "timeline": "" }));
    b.put_page(slug, &input, &args(json!({ "sourceId": source })))
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

#[test]
fn page_refs_by_id_name_each_listed_page_once_deleted_pages_and_other_sources_included() {
    let b = brain("tier-reads-page-refs");
    other_source(&b);
    let chat = put_ref(&b, "default", "quote/chat", "chat");
    let note = put_ref(&b, "default", "quote/note", "note");
    let gone = put_ref(&b, "default", "quote/gone", "transcript");
    let elsewhere = put_ref(&b, "other", "quote/elsewhere", "person");
    b.soft_delete_page("quote/gone", Some("default")).unwrap();

    let q: PageIdsQuery = args(json!({ "ids": [elsewhere, gone, note, chat, note, 987_654, -1] }));
    assert_eq!(
        b.list_page_refs_by_ids(&q).unwrap(),
        [
            json!({ "id": chat, "source_id": "default", "slug": "quote/chat", "type": "chat" }),
            json!({ "id": note, "source_id": "default", "slug": "quote/note", "type": "note" }),
            json!({ "id": gone, "source_id": "default", "slug": "quote/gone", "type": "transcript" }),
            json!({ "id": elsewhere, "source_id": "other", "slug": "quote/elsewhere", "type": "person" }),
        ]
    );
    let none: PageIdsQuery = args(json!({ "ids": [] }));
    assert!(b.list_page_refs_by_ids(&none).unwrap().is_empty());
}
