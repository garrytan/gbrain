//! The doctor facts, fence and trust reads (`cli_reads/doctor_facts_trust.rs`, `jobs/checks.rs`): the PGLite semantics of each.

mod memory_env;

use gbrain_store::cli_reads::doctor_facts_trust::ConversationPipelineSpec;
use gbrain_store::jobs::{AdmitSpec, ClaimSpec};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::stats::IngestInput;
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
