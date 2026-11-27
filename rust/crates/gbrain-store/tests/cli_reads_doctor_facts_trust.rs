//! The doctor facts, fence and trust reads (`cli_reads/doctor_facts_trust.rs`, `jobs/checks.rs`): the PGLite semantics of each.

mod memory_env;

use gbrain_store::cli_reads::doctor_facts_trust::{
    ConversationPipelineSpec, LegacyUnknownSpec, TrustTableSpec,
};
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::jobs::{AdmitSpec, ClaimSpec};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use gbrain_store::stats::IngestInput;
use gbrain_store::takes::TakeInput;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use gbrain_store::trust::derivation::TaintCountQuery;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const HOUR: i64 = 3_600_000_000;

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(s: &Brain, slug: &str, page_type: &str) {
    let input: PageInput =
        args(json!({ "type": page_type, "title": slug, "compiled_truth": "body" }));
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

#[test]
fn conversation_pipeline_pages_skip_deleted_pages_other_types_and_rescued_slugs() {
    let s = brain("pipeline");
    let spec: ConversationPipelineSpec = args(
        json!({ "types": ["transcript", "chat"], "slug_patterns": ["meetings/%", "daily/%"] }),
    );
    assert_eq!(s.count_conversation_pipeline_pages(&spec).unwrap(), 0);
    put(&s, "convos/a", "transcript");
    put(&s, "convos/b", "chat");
    put(&s, "meetings/m1", "transcript");
    put(&s, "daily/d1", "chat");
    put(&s, "notes/n1", "note");
    put(&s, "convos/gone", "transcript");
    s.soft_delete_page("convos/gone", None).unwrap();
    assert_eq!(s.count_conversation_pipeline_pages(&spec).unwrap(), 2);
    // No pattern rescues nothing; an underscore is a LIKE wildcard, as in SQL.
    let none: ConversationPipelineSpec =
        args(json!({ "types": ["transcript"], "slug_patterns": [] }));
    assert_eq!(s.count_conversation_pipeline_pages(&none).unwrap(), 2);
    let one: ConversationPipelineSpec =
        args(json!({ "types": ["transcript"], "slug_patterns": ["convos/_"] }));
    assert_eq!(s.count_conversation_pipeline_pages(&one).unwrap(), 1);
}

fn ingest(s: &Brain, source_id: &str, slug: &str, summary: &str) {
    let input: IngestInput = args(json!({
        "source_id": source_id, "source_type": "facts:absorb", "source_ref": slug,
        "pages_updated_json": "[]", "summary": summary,
    }));
    s.log_ingest(&input).unwrap();
}

fn complete_absorb(s: &Brain, slug: &str, data: Value) {
    let mut data = data;
    data["slug"] = json!(slug);
    let spec: AdmitSpec = args(json!({ "maxSpawnDepth": 5, "insert": {
        "name": "facts-absorb", "queue": "default", "status": "waiting", "priority": 0, "data": data,
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000, "backoff_jitter": 0.2,
        "on_child_fail": "fail_parent", "remove_on_complete": false, "remove_on_fail": false,
        "submission_authority": { "version": 1, "kind": "application" } } }));
    let id = s.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
    let claim: ClaimSpec = args(json!({
        "lockToken": "t", "lockDurationMs": 30000, "queue": "default", "names": ["facts-absorb"],
        "suspectMark": "watchdog_suspect", "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": { "groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5 } }));
    s.claim_next_job(&claim).unwrap().unwrap();
    s.complete_job(id, "t", None).unwrap().unwrap();
}

#[test]
fn writer_contention_lists_sources_with_uncovered_deferrals_that_persist() {
    let s = brain("contention");
    let reason = "write_deferred_unadmitted";
    assert!(
        s.list_persistent_writer_contention(reason)
            .unwrap()
            .is_empty()
    );
    // One fresh deferral: neither more than ten nor over an hour old.
    ingest(&s, "fresh", "p1", &format!("{reason}: busy"));
    assert!(
        s.list_persistent_writer_contention(reason)
            .unwrap()
            .is_empty()
    );
    s.clock.advance(2 * HOUR);
    // `fresh` is now two hours old, so it persists. `old` is newer; another reason never counts, and a later completed job covers a row.
    ingest(&s, "old", "p2", &format!("{reason}: busy"));
    ingest(&s, "other-reason", "p3", "timeout: x");
    ingest(&s, "covered", "p4", &format!("{reason}: busy"));
    ingest(&s, "covered-default", "p5", &format!("{reason}: busy"));
    s.clock.advance(HOUR + 1);
    complete_absorb(&s, "p4", json!({ "sourceId": "covered" }));
    complete_absorb(&s, "p5", json!({}));
    // `covered-default`'s job names no source, so it covers only a row of the `default` source.
    let rows = s.list_persistent_writer_contention(reason).unwrap();
    let sources: Vec<&str> = rows
        .iter()
        .map(|r| r["source_id"].as_str().unwrap())
        .collect();
    assert_eq!(sources, vec!["covered-default", "fresh", "old"]);
    assert_eq!(rows[2]["n"], 1);
    assert_eq!(rows[2]["oldest"], "2027-01-15T10:00:00.000000Z");
    // More than ten fresh deferrals persist on their own.
    for i in 0..11 {
        ingest(&s, "busy", &format!("b{i}"), &format!("{reason}: busy"));
    }
    let rows = s.list_persistent_writer_contention(reason).unwrap();
    let busy = rows.iter().find(|r| r["source_id"] == "busy").unwrap();
    assert_eq!(busy["n"], 11);
    // Past the 24 hour window nothing counts.
    s.clock.advance(25 * HOUR);
    assert!(
        s.list_persistent_writer_contention(reason)
            .unwrap()
            .is_empty()
    );
}

/// Runs `f` in a transaction that declares `tier` and the write `origin` (no declaration for `None`).
fn stamped(s: &Brain, stamp: Option<(&str, Value)>, f: impl FnOnce(&gbrain_store::Store)) {
    let tx = s.begin_transaction(false).unwrap();
    if let Some((tier, origin)) = stamp {
        let names = [
            "gbrain.write_trust_tier",
            "gbrain.write_trust_promotion",
            "gbrain.write_origin",
        ]
        .map(String::from);
        tx.apply_write_trust(&names, &[tier.into(), tier.into(), origin.to_string()])
            .unwrap();
    }
    f(&tx);
    tx.commit_transaction().unwrap();
}

fn table(name: &str) -> TrustTableSpec {
    args(json!({ "table": name }))
}

/// One page with a fact, a take and a timeline entry per row of `ROWS`, each written under that row's stamp.
fn seed_trust(s: &Brain) {
    let rows: [(Option<&str>, Value); 5] = [
        (
            Some("agent_written"),
            json!({ "channel": "agent", "taint_inputs": [{ "table": "pages", "id": 1 }] }),
        ),
        (
            Some("external_untrusted"),
            json!({ "channel": "agent", "taint_inputs": [{ "table": "pages", "id": 2 }] }),
        ),
        (Some("external_untrusted"), json!({ "channel": "web" })),
        (
            Some("operator_curated"),
            json!({ "channel": "trust_claim" }),
        ),
        (None, Value::Null),
    ];
    let mut holder = 0;
    stamped(
        s,
        Some(("operator_curated", json!({ "channel": "import" }))),
        |tx| {
            let input: PageInput = args(
                json!({ "type": "note", "title": "H", "compiled_truth": "h", "timeline": "" }),
            );
            holder = tx
                .put_page("trust/holder", &input, &PutPageOptions::default())
                .unwrap()["id"]
                .as_i64()
                .unwrap();
        },
    );
    for (i, (tier, origin)) in rows.into_iter().enumerate() {
        stamped(s, tier.map(|t| (t, origin)), |tx| {
            let input: PageInput = args(
                json!({ "type": "note", "title": format!("P{i}"), "compiled_truth": "p", "timeline": "" }),
            );
            tx.put_page(
                &format!("trust/page-{i}"),
                &input,
                &PutPageOptions::default(),
            )
            .unwrap();
            tx.insert_facts(&args::<gbrain_store::facts::InsertFactsArgs>(json!({
                "rows": [{ "fact": format!("fact {i}"), "entity_slug": "people/a-example", "source_markdown_slug": "trust/holder",
                    "row_num": i + 1, "kind": "fact", "visibility": "world", "source": "cli", "context": "ctx" }],
                "sourceId": "default" }))).unwrap();
            let take: TakeInput = args(
                json!({ "page_id": holder, "row_num": i + 1, "claim": format!("take {i}"),
                "kind": "take", "holder": "h", "weight": 0.5, "active": true }),
            );
            tx.add_takes_batch(&[take]).unwrap();
            let entry: TimelineInput = args(
                json!({ "date": format!("2026-07-0{}", i + 1), "summary": format!("entry {i}") }),
            );
            tx.add_timeline_entry("trust/holder", &entry, &AddTimelineOptions::default())
                .unwrap();
        });
    }
}

#[test]
fn row_trust_tiers_count_each_stored_tier_of_facts_takes_and_timeline_entries() {
    let s = brain("trust-tiers");
    for name in ["facts", "takes", "timeline_entries"] {
        assert_eq!(
            s.count_row_trust_tiers(&table(name)).unwrap(),
            Vec::<Value>::new(),
            "{name}"
        );
    }
    seed_trust(&s);
    let want = vec![
        json!({ "tier": "agent_written", "n": 1 }),
        json!({ "tier": "external_untrusted", "n": 2 }),
        json!({ "tier": "operator_curated", "n": 1 }),
        json!({ "tier": "unknown", "n": 1 }),
    ];
    for name in ["facts", "takes", "timeline_entries"] {
        assert_eq!(
            s.count_row_trust_tiers(&table(name)).unwrap(),
            want,
            "{name}"
        );
    }
    for read in [
        s.count_row_trust_tiers(&table("links")),
        s.count_row_trust_tiers(&table("pages;")),
    ] {
        assert_eq!(read.unwrap_err().code, INVALID_ARGUMENT);
    }
}

#[test]
fn derived_taint_rows_count_taint_inputs_and_those_stamped_external() {
    let s = brain("trust-taint");
    assert_eq!(
        s.count_derived_fact_taint().unwrap(),
        json!({ "derived": 0, "external": 0 })
    );
    seed_trust(&s);
    for name in ["facts", "takes", "timeline_entries", "pages"] {
        assert_eq!(
            if name == "facts" {
                s.count_derived_fact_taint()
            } else {
                s.count_derived_row_taint(&TaintCountQuery { table: name.into() })
            }
            .unwrap(),
            json!({ "derived": 2, "external": 1 }),
            "{name}"
        );
        assert_eq!(
            s.count_claim_lifted_rows(&table(name)).unwrap(),
            json!(1),
            "{name}"
        );
    }
    assert_eq!(
        s.count_claim_lifted_rows(&table("links")).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn legacy_unknown_rows_count_per_source_within_the_ceilings_and_scope() {
    let s = brain("trust-legacy");
    s.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    let spec = |v: Value| -> LegacyUnknownSpec { args(v) };
    let mut ceilings = json!(null);
    for (round, (slug, source)) in [
        ("legacy/a", "default"),
        ("legacy/b", "other"),
        ("legacy/c", "other"),
        ("legacy/d", "default"),
    ]
    .into_iter()
    .enumerate()
    {
        let tx = s.begin_transaction(false).unwrap();
        let input: PageInput =
            args(json!({ "type": "note", "title": slug, "compiled_truth": "b", "timeline": "" }));
        let page = tx
            .put_page(slug, &input, &args(json!({ "sourceId": source })))
            .unwrap();
        let page_id = page["id"].as_i64().unwrap();
        let fact = tx.insert_facts(&args::<gbrain_store::facts::InsertFactsArgs>(json!({
            "rows": [{ "fact": slug, "entity_slug": "people/a-example", "source_markdown_slug": slug,
                "row_num": round + 1, "kind": "fact", "visibility": "world", "source": "cli", "context": "ctx" }],
            "sourceId": source }))).unwrap();
        let take: TakeInput = args(
            json!({ "page_id": page_id, "row_num": 1, "claim": slug, "kind": "take", "holder": "h", "weight": 0.5, "active": true }),
        );
        tx.add_takes_batch(&[take]).unwrap();
        let entry: TimelineInput = args(json!({ "date": "2026-07-01", "summary": slug }));
        tx.add_timeline_entry(
            slug,
            &entry,
            &AddTimelineOptions {
                source_id: Some(source.into()),
                ..Default::default()
            },
        )
        .unwrap();
        let take_id = tx
            .list_trust_scan_rows(&args(
                json!({ "table": "takes", "afterId": 0, "limit": 50, "tiers": ["unknown"] }),
            ))
            .unwrap()
            .last()
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let entry_id = tx.list_trust_scan_rows(&args(json!({ "table": "timeline_entries", "afterId": 0, "limit": 50, "tiers": ["unknown"] }))).unwrap()
            .last().unwrap()["id"].as_i64().unwrap();
        tx.commit_transaction().unwrap();
        if round == 2 {
            ceilings = json!({ "pages": page_id, "facts": fact["ids"][0], "takes": take_id, "timeline_entries": entry_id });
        }
    }
    s.soft_delete_page("legacy/c", Some("other")).unwrap();
    let rows = |v: Value| s.count_legacy_unknown_by_source(&spec(v)).unwrap();
    // The deleted page leaves the page count only: its fact, take and entry still count.
    assert_eq!(
        rows(json!({ "ceilings": null })),
        [
            json!({ "source_id": "default", "n": 8 }),
            json!({ "source_id": "other", "n": 7 })
        ]
    );
    assert_eq!(
        rows(json!({ "ceilings": ceilings })),
        [
            json!({ "source_id": "default", "n": 4 }),
            json!({ "source_id": "other", "n": 7 })
        ]
    );
    assert_eq!(
        rows(json!({ "ceilings": null, "sourceIds": ["other"] })),
        [json!({ "source_id": "other", "n": 7 })]
    );
    assert_eq!(
        rows(json!({ "ceilings": null, "sourceIds": [] })),
        Vec::<Value>::new()
    );
    assert_eq!(
        rows(json!({ "ceilings": { "pages": 0, "facts": 0, "takes": 0, "timeline_entries": 0 } })),
        Vec::<Value>::new()
    );
}

#[test]
fn a_fresh_brain_starts_with_the_trust_backfill_done_and_the_write_gate_scan_baseline_at_zero() {
    let s = brain("trust-baseline");
    let text = s.get_config("write_gate.scan_baseline").unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({ "detector_version": 2,
                "until": { "facts": 0, "pages": 0, "takes": 0, "timeline_entries": 0 } })
    );
    // v226 marks the backfill complete on an empty brain, at the store's clock in millisecond ISO form.
    assert_eq!(
        s.get_config("trust.backfill_completed_at")
            .unwrap()
            .as_deref(),
        Some("2027-01-15T08:00:00.000Z")
    );
    // A page written now is above the baseline ceiling, so it is not legacy.
    put(&s, "legacy/a", "note");
    let spec: LegacyUnknownSpec = args(json!({ "ceilings": {
        "pages": 0, "facts": 0, "takes": 0, "timeline_entries": 0 } }));
    assert!(s.count_legacy_unknown_by_source(&spec).unwrap().is_empty());
}

#[test]
fn a_claim_lifted_row_an_owner_decided_since_is_not_counted() {
    let s = brain("trust-claim-decided");
    let mut id = 0;
    stamped(
        &s,
        Some(("operator_curated", json!({ "channel": "trust_claim" }))),
        |tx| {
            let input: PageInput = args(
                json!({ "type": "note", "title": "C", "compiled_truth": "c", "timeline": "" }),
            );
            id = tx
                .put_page("trust/claimed", &input, &PutPageOptions::default())
                .unwrap()["id"]
                .as_i64()
                .unwrap();
        },
    );
    assert_eq!(
        s.count_claim_lifted_rows(&table("pages")).unwrap(),
        json!(1)
    );
    // `trust confirm` merges owner_decision into the claim's write origin (#10178): the row is settled, not relowerable.
    let decision =
        json!({ "tier": "user_confirmed", "at": "2026-11-25T00:00:00.000Z" }).to_string();
    let tx = s.begin_transaction(false).unwrap();
    tx.apply_write_trust(
        &["gbrain.write_trust_promotion".to_string()],
        &["user_confirmed".to_string()],
    )
    .unwrap();
    assert_eq!(
        tx.set_row_trust_tier("pages", id as f64, "user_confirmed", &decision)
            .unwrap(),
        vec![id as u64]
    );
    tx.commit_transaction().unwrap();
    assert_eq!(
        s.count_claim_lifted_rows(&table("pages")).unwrap(),
        json!(0)
    );
}
