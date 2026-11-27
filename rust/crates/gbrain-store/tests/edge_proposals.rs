//! The edge-contradiction phase and its proposal ledger (`edge_proposals.rs`), each against the
//! rows the PGLite SQL of src/core/engine-sql/contradictions-cycle.ts returns.

mod memory_env;

use gbrain_store::edge_proposals::{EdgeCandidateQuery, EdgeProposalInput};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::extraction::ExtractedRef;
use gbrain_store::link_queries::{ApplyTemporalInput, EdgeValidityInput, StateWrite};
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const HOUR: i64 = 3_600_000_000;
/// The UTC day of `T0`.
const TODAY: &str = "2027-01-15";

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str, page_type: &str) -> u64 {
    let input: PageInput =
        de(json!({ "type": page_type, "title": format!("T {slug}"), "compiled_truth": "x" }));
    let opts: PutPageOptions = de(json!({ "sourceId": "default", "index": false }));
    b.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn link(b: &Brain, from: &str, to: &str, link_type: &str) {
    let options = AddLinkOptions {
        link_type: Some(link_type.into()),
        link_source: Some("manual".into()),
        ..AddLinkOptions::default()
    };
    b.add_link(from, to, &options).unwrap();
}

/// One live `all`-scope state row from `from` to `to`.
fn state(from: u64, to: u64, link_type: &str, last_start: Value, hash: &str) -> Value {
    json!({
        "from_page_id": from, "to_page_id": to, "link_type": link_type, "scope": "all", "source_id": "default",
        "semantics": "state", "valid_ranges": "{[2020-01-01,)}", "status_now": "live", "first_start": last_start,
        "last_start": last_start, "last_end": null, "undated_present": 1, "undated_past": 0, "disputed": false,
        "recorded_at": "2026-01-02T00:00:00.000Z", "retired_at": null, "evidence_hash": hash,
    })
}

fn write_state(b: &Brain, rows: Value) {
    let input: StateWrite = de(json!({ "upserts": rows, "removals": [], "changed": 0 }));
    b.write_link_relationship_state(&input).unwrap();
}

fn proposal(from: u64, a: u64, b: u64, hash: &str, status: &str) -> EdgeProposalInput {
    de(json!({
        "sourceId": "default", "fromPageId": from, "aToPageId": a, "bToPageId": b, "linkType": "works_at",
        "evidenceHash": hash, "status": status, "endingToPageId": a, "closeDate": "2025-03-01",
        "bornClosed": false, "model": "m", "confidence": 0.8, "generatedLine": "- 2025-03-01: left", "detail": null,
    }))
}

/// The dream transitions `from` owns ending `from -> to`, replaced in one apply.
fn dream_ends(b: &Brain, from: u64, from_slug: &str, ends: &[(&str, &str)]) {
    let transitions: Vec<Value> = ends
        .iter()
        .map(|(to, on)| {
            json!({ "from_slug": from_slug, "to_slug": to, "link_type": "works_at", "kind": "end",
                    "occurred_on": on, "date_precision": "day", "producer": "dream", "line_hash": "h" })
        })
        .collect();
    let input: ApplyTemporalInput = de(json!({
        "pageId": from, "sourceId": "default", "tenseRows": [], "transitions": transitions,
        "explicitTargets": [], "producers": ["dream"], "linkTypes": ["works_at"],
    }));
    b.apply_link_temporal_rows(&input).unwrap();
}

fn candidates(b: &Brain, query: Value) -> Vec<String> {
    let q: EdgeCandidateQuery = de(query);
    b.list_edge_contradiction_candidates(&q)
        .unwrap()
        .iter()
        .map(|r| {
            format!(
                "{}>{}",
                r["subject_slug"].as_str().unwrap(),
                r["target_slug"].as_str().unwrap()
            )
        })
        .collect()
}

fn query(extra: Value) -> Value {
    let mut q = json!({
        "today": TODAY, "maxSubjects": 10, "pendingCutoff": null,
        "personFilter": { "types": ["person"], "per_source": [] },
        "nonEmployerTypes": ["school"], "nonEmployerPrefixes": ["schools/"],
    });
    for (k, v) in extra.as_object().unwrap() {
        q[k] = v.clone();
    }
    q
}

#[test]
fn a_proposal_is_recorded_once_and_an_error_row_is_replaced_in_place() {
    let b = brain("edge-record");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    let id = b
        .record_edge_proposal(&proposal(alice, acme, widget, "h1", "proposed"))
        .unwrap()
        .unwrap();
    assert_eq!(
        b.record_edge_proposal(&proposal(alice, acme, widget, "h1", "compatible"))
            .unwrap(),
        None
    );
    // A conflict still draws an id, as `DEFAULT nextval` does.
    let err = b
        .record_edge_proposal(&proposal(alice, acme, widget, "h2", "error"))
        .unwrap()
        .unwrap();
    assert_eq!(err, id + 2);
    b.clock.advance(HOUR);
    assert_eq!(
        b.record_edge_proposal(&proposal(alice, acme, widget, "h2", "compatible"))
            .unwrap(),
        Some(err)
    );
    let row = b.read_edge_proposal(err as f64).unwrap().unwrap();
    assert_eq!(
        row,
        json!({
            "id": err, "source_id": "default", "status": "compatible", "from_page_id": alice,
            "ending_to_page_id": acme, "link_type": "works_at", "close_date": "2025-03-01",
            "generated_line": "- 2025-03-01: left", "subject_slug": "people/alice", "ending_slug": "companies/acme",
        })
    );
    assert_eq!(
        b.read_edge_proposal_hash(id as f64).unwrap(),
        Some(json!({ "evidence_hash": "h1" }))
    );
    assert_eq!(b.read_edge_proposal(99.0).unwrap(), None);
    assert_eq!(b.read_edge_proposal(1.5).unwrap(), None);
    assert_eq!(b.read_edge_proposal_hash(-1.0).unwrap(), None);

    // recent: touched in the last 24 hours, read at the store's clock.
    b.clock.advance(23 * HOUR + 30 * 60_000_000);
    let known = b
        .list_known_edge_proposals(
            alice as f64,
            "works_at",
            &["h1".into(), "h2".into(), "h9".into()],
        )
        .unwrap();
    assert_eq!(
        known,
        vec![
            json!({ "a": acme, "b": widget, "status": "proposed", "detail": null, "recent": false }),
            json!({ "a": acme, "b": widget, "status": "compatible", "detail": null, "recent": true }),
        ]
    );
    assert!(
        b.list_known_edge_proposals(alice as f64, "advises", &["h1".into()])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn records_refuse_what_the_table_refuses() {
    let b = brain("edge-refuse");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let bad = b
        .record_edge_proposal(&proposal(alice, acme, acme, "h", "maybe"))
        .unwrap_err();
    assert_eq!(bad.code, CONSTRAINT_VIOLATION);
    assert!(bad.message.contains("link_edge_proposals_status_check"));
    let missing = b
        .record_edge_proposal(&proposal(alice, acme, 999, "h", "proposed"))
        .unwrap_err();
    assert_eq!(missing.code, CONSTRAINT_VIOLATION);
    assert!(missing.message.contains("b_to_page_id_fkey"));
    let mut dated = proposal(alice, acme, acme, "h", "proposed");
    dated.close_date = Some("2025-02-30".into());
    assert_eq!(
        b.record_edge_proposal(&dated).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let mut nul = proposal(alice, acme, acme, "h", "proposed");
    nul.detail = Some("a\0b".into());
    assert_eq!(
        b.record_edge_proposal(&nul).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let id = b
        .record_edge_proposal(&proposal(alice, acme, acme, "h", "proposed"))
        .unwrap()
        .unwrap();
    assert_eq!(
        b.set_edge_proposal_status(id as f64, "maybe")
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    // No row: nothing to check, nothing changes.
    b.set_edge_proposal_status(99.0, "maybe").unwrap();
}

#[test]
fn statuses_move_and_only_an_open_proposal_is_rejected() {
    let b = brain("edge-status");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    let id = b
        .record_edge_proposal(&proposal(alice, acme, widget, "h", "undated_unresolved"))
        .unwrap()
        .unwrap() as f64;
    let status = |b: &Brain| b.read_edge_proposal(id).unwrap().unwrap()["status"].clone();
    b.mark_edge_proposal_stale(id).unwrap();
    assert_eq!(status(&b), "stale");
    assert!(!b.reject_open_edge_proposal(id).unwrap());
    b.set_edge_proposal_status(id, "ambiguous_same_date")
        .unwrap();
    assert!(b.reject_open_edge_proposal(id).unwrap());
    assert_eq!(status(&b), "rejected");
    assert!(!b.reject_open_edge_proposal(id).unwrap());
    b.mark_edge_proposal_undone(id).unwrap();
    assert_eq!(status(&b), "undone");
    assert!(!b.reject_open_edge_proposal(99.0).unwrap());
}

#[test]
fn edge_validity_counts_the_proposals_by_status_within_the_source_scope() {
    let b = brain("edge-validity-proposals");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    for (hash, status) in [
        ("e1", "proposed"),
        ("e2", "proposed"),
        ("e3", "undated_unresolved"),
        ("e4", "applied"),
        ("e5", "rejected"),
    ] {
        b.record_edge_proposal(&proposal(alice, acme, widget, hash, status))
            .unwrap()
            .unwrap();
    }
    let counts = |scope: Value| {
        let input: EdgeValidityInput = de(json!({ "sourceIds": scope, "staleLimit": 21 }));
        serde_json::to_value(b.edge_validity_counts(&input).unwrap()).unwrap()["proposals"].clone()
    };
    assert_eq!(
        counts(Value::Null),
        json!({"proposed": 2, "undated": 1, "applied": 1})
    );
    assert_eq!(
        counts(json!(["default"])),
        json!({"proposed": 2, "undated": 1, "applied": 1})
    );
    assert_eq!(
        counts(json!(["elsewhere"])),
        json!({"proposed": 0, "undated": 0, "applied": 0})
    );
}

#[test]
fn a_closure_lands_through_a_dream_end_transition_and_its_removal_reverts_the_proposal() {
    let b = brain("edge-closure");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    link(&b, "people/alice", "companies/acme", "works_at");
    link(&b, "people/alice", "companies/widget", "works_at");
    let landed = |b: &Brain, ending: Option<f64>, date: Option<&str>| {
        b.edge_closure_landed(alice as f64, ending, "works_at", date)
            .unwrap()
    };
    assert!(!landed(&b, Some(acme as f64), Some("2025-03-01")));
    // The transition layout of link_temporal.rs, written through its public writer.
    dream_ends(
        &b,
        alice,
        "people/alice",
        &[("companies/acme", "2025-03-01")],
    );
    assert!(landed(&b, Some(acme as f64), Some("2025-03-01")));
    assert!(!landed(&b, Some(acme as f64), Some("2025-03-02")));
    assert!(!landed(&b, Some(widget as f64), Some("2025-03-01")));
    assert!(!landed(&b, None, Some("2025-03-01")));
    assert!(!landed(&b, Some(acme as f64), None));
    assert!(
        !b.edge_closure_landed(
            alice as f64,
            Some(acme as f64),
            "advises",
            Some("2025-03-01")
        )
        .unwrap()
    );
    assert_eq!(
        b.edge_closure_landed(alice as f64, Some(acme as f64), "works_at", Some("March"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );

    let applied = b
        .record_edge_proposal(&proposal(alice, acme, widget, "h", "proposed"))
        .unwrap()
        .unwrap() as f64;
    let mut no_ending = proposal(alice, widget, acme, "h", "proposed");
    no_ending.ending_to_page_id = None;
    let unended = b.record_edge_proposal(&no_ending).unwrap().unwrap() as f64;
    b.set_edge_proposal_status(applied, "applied").unwrap();
    b.set_edge_proposal_status(unended, "applied").unwrap();
    // Touched now: `updated_at < now()` holds for neither.
    assert_eq!(b.mark_reverted_edge_proposals().unwrap(), 0);
    b.clock.advance(1);
    // The applied closure still stands; the one with no ending counts as reverted.
    assert_eq!(b.mark_reverted_edge_proposals().unwrap(), 1);
    let status = |id: f64| b.read_edge_proposal(id).unwrap().unwrap()["status"].clone();
    assert_eq!(status(unended), "reverted_by_user");
    assert_eq!(status(applied), "applied");
    dream_ends(&b, alice, "people/alice", &[]);
    b.clock.advance(1);
    assert_eq!(b.mark_reverted_edge_proposals().unwrap(), 1);
    assert_eq!(status(applied), "reverted_by_user");
    assert_eq!(b.mark_reverted_edge_proposals().unwrap(), 0);
}

#[test]
fn the_evidence_read_answers_both_all_scope_hashes_or_none() {
    let b = brain("edge-evidence");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    link(&b, "people/alice", "companies/acme", "works_at");
    link(&b, "people/alice", "companies/widget", "works_at");
    let id = b
        .record_edge_proposal(&proposal(alice, acme, widget, "h", "proposed"))
        .unwrap()
        .unwrap() as f64;
    // The relationship layout of link_temporal.rs, written through its public writer.
    write_state(
        &b,
        json!([state(alice, acme, "works_at", json!(null), "ha")]),
    );
    assert_eq!(b.read_edge_proposal_evidence(id).unwrap(), None);
    write_state(
        &b,
        json!([state(alice, widget, "works_at", json!(null), "hb")]),
    );
    assert_eq!(
        b.read_edge_proposal_evidence(id).unwrap(),
        Some(json!({ "a": "ha", "b": "hb" }))
    );
    assert_eq!(b.read_edge_proposal_evidence(99.0).unwrap(), None);
}

#[test]
fn candidates_are_live_state_groups_with_two_targets_and_works_at_needs_an_employer() {
    let b = brain("edge-candidates");
    let alice = page(&b, "people/alice", "person");
    let bob = page(&b, "people/bob", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    let school = page(&b, "schools/u", "school");
    let untyped = page(&b, "schools/v", "");
    let carol = page(&b, "people/carol", "founder");
    for (from, to) in [
        ("people/alice", "companies/acme"),
        ("people/alice", "companies/widget"),
        ("people/alice", "people/bob"),
        ("people/alice", "schools/u"),
        ("people/alice", "schools/v"),
        ("people/carol", "companies/acme"),
        ("people/carol", "companies/widget"),
    ] {
        link(&b, from, to, "works_at");
    }
    link(&b, "people/bob", "companies/acme", "advises");
    link(&b, "people/bob", "companies/widget", "advises");
    write_state(
        &b,
        json!([
            state(alice, widget, "works_at", json!("2022-01-01"), "w"),
            state(alice, acme, "works_at", json!(null), "a"),
            state(alice, bob, "works_at", json!(null), "b"),
            state(alice, school, "works_at", json!(null), "s"),
            state(alice, untyped, "works_at", json!(null), "u"),
            state(carol, acme, "works_at", json!(null), "c1"),
            state(carol, widget, "works_at", json!(null), "c2"),
            state(bob, acme, "advises", json!("2021-01-01"), "d1"),
            state(bob, widget, "advises", json!("2020-06-01"), "d2"),
        ]),
    );
    let rows = candidates(&b, query(json!({})));
    // Ordered by subject id, link type, last_start NULLS FIRST, target slug.
    assert_eq!(
        rows,
        vec![
            "people/alice>companies/acme",
            "people/alice>companies/widget",
            "people/bob>companies/widget",
            "people/bob>companies/acme",
        ]
    );
    let q: EdgeCandidateQuery = de(query(json!({})));
    let first = &b.list_edge_contradiction_candidates(&q).unwrap()[0];
    assert_eq!(
        first,
        &json!({
            "source_id": "default", "from_page_id": alice, "to_page_id": acme, "link_type": "works_at",
            "valid_ranges": "{[2020-01-01,)}", "last_start": null, "recorded_at": "2026-01-02T00:00:00.000000Z",
            "evidence_hash": "a", "subject_slug": "people/alice", "subject_title": "T people/alice",
            "target_slug": "companies/acme", "target_title": "T companies/acme",
        })
    );
    // A per-source arm decides for its source; founders become person-like.
    let founders = json!({ "personFilter": { "types": ["person"], "per_source": [{ "source_id": "default", "types": ["person", "founder"] }] } });
    assert!(candidates(&b, query(founders)).contains(&"people/carol>companies/acme".to_string()));
    // Not on the day asked about.
    assert!(candidates(&b, query(json!({ "today": "2019-12-31" }))).is_empty());
    assert_eq!(candidates(&b, query(json!({ "maxSubjects": 1 }))).len(), 2);
    assert!(candidates(&b, query(json!({ "maxSubjects": 0 }))).is_empty());
    // The cutoff admits subjects whose links were extracted at or after it.
    assert!(
        candidates(
            &b,
            query(json!({ "pendingCutoff": "2027-01-01T00:00:00Z" }))
        )
        .is_empty()
    );
    let refs: Vec<ExtractedRef> = de(json!([{ "slug": "people/bob", "source_id": "default" }]));
    b.mark_pages_extracted_batch(&refs, "2027-01-01T00:00:00.000Z")
        .unwrap();
    assert_eq!(
        candidates(
            &b,
            query(json!({ "pendingCutoff": "2027-01-01T00:00:00Z" }))
        ),
        vec!["people/bob>companies/widget", "people/bob>companies/acme"]
    );
    assert!(
        candidates(
            &b,
            query(json!({ "pendingCutoff": "2027-01-01T00:00:01Z" }))
        )
        .is_empty()
    );
    // A soft-deleted target leaves the group with one target.
    b.soft_delete_page("companies/widget", None).unwrap();
    assert!(candidates(&b, query(json!({}))).is_empty());
    for bad in [
        json!({ "today": "soon" }),
        json!({ "maxSubjects": -1 }),
        json!({ "maxSubjects": 1.5 }),
        json!({ "pendingCutoff": "yesterday" }),
    ] {
        let q: EdgeCandidateQuery = de(query(bad));
        assert_eq!(
            b.list_edge_contradiction_candidates(&q).unwrap_err().code,
            INVALID_ARGUMENT
        );
    }
}

/// Groups that share one refresh stamp are cut by `maxSubjects` at the lowest subject page id, whichever
/// source holds them: the SQL's `ORDER BY max(refreshed_at) DESC, from_page_id, link_type`.
#[test]
fn groups_that_tie_on_the_refresh_stamp_are_cut_at_the_lowest_subject_page_id() {
    let b = brain("edge-tie-cut");
    let first = page(&b, "people/first", "person");
    let second = page(&b, "people/second", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    // The lower page id belongs to the source that sorts later, so a source-first order would cut the wrong subject.
    let mut rows = Vec::new();
    for (subject, source, hash) in [(first, "src-b", "f"), (second, "src-a", "s")] {
        for (target, tag) in [(acme, "a"), (widget, "w")] {
            let mut row = state(
                subject,
                target,
                "works_at",
                Value::Null,
                &format!("{hash}{tag}"),
            );
            row["source_id"] = json!(source);
            rows.push(row);
        }
    }
    write_state(&b, json!(rows));
    assert_eq!(
        candidates(&b, query(json!({ "maxSubjects": 1 }))),
        vec![
            "people/first>companies/acme",
            "people/first>companies/widget"
        ]
    );
}

#[test]
fn a_hard_delete_removes_the_proposals_of_its_pages_and_clears_an_ending() {
    let b = brain("edge-cascade");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    let globex = page(&b, "companies/globex", "company");
    let mut ends_globex = proposal(alice, acme, widget, "keep", "proposed");
    ends_globex.ending_to_page_id = Some(globex as f64);
    let kept = b.record_edge_proposal(&ends_globex).unwrap().unwrap();
    let gone = b
        .record_edge_proposal(&proposal(alice, acme, globex, "gone", "proposed"))
        .unwrap()
        .unwrap();
    b.delete_page("companies/globex", None).unwrap();
    assert_eq!(b.read_edge_proposal(gone as f64).unwrap(), None);
    let row = b.read_edge_proposal(kept as f64).unwrap().unwrap();
    assert_eq!(row["ending_to_page_id"], Value::Null);
    assert_eq!(row["ending_slug"], Value::Null);
    // The removed row's unique key went with it.
    assert_eq!(
        b.list_known_edge_proposals(alice as f64, "works_at", &["keep".into(), "gone".into()])
            .unwrap()
            .len(),
        1
    );
    b.delete_page("people/alice", None).unwrap();
    assert_eq!(b.read_edge_proposal(kept as f64).unwrap(), None);
    assert!(
        b.list_known_edge_proposals(alice as f64, "works_at", &["keep".into(), "gone".into()])
            .unwrap()
            .is_empty()
    );
}

/// The ids, in order, of `[{ id }]`.
fn id_list(v: &Value) -> Vec<u64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect()
}

#[test]
fn the_edge_proposals_command_lists_filters_clears_and_dates_proposals() {
    use gbrain_store::edge_proposals::EdgeProposalCliFilter;
    let b = brain("edge-cli");
    let alice = page(&b, "people/alice", "person");
    let acme = page(&b, "companies/acme", "company");
    let widget = page(&b, "companies/widget", "company");
    let record = |hash: &str, status: &str, edit: Value| {
        let mut p = json!({
            "sourceId": "default", "fromPageId": alice, "aToPageId": acme, "bToPageId": widget, "linkType": "works_at",
            "evidenceHash": hash, "status": status, "endingToPageId": acme, "closeDate": "2025-03-01",
            "bornClosed": false, "model": "m", "confidence": 0.9, "generatedLine": "line", "detail": null,
        });
        for (k, v) in edit.as_object().unwrap() {
            p[k] = v.clone();
        }
        let id = b.record_edge_proposal(&de(p)).unwrap().unwrap();
        b.clock.advance(HOUR);
        id
    };
    let proposed = record("h1", "proposed", json!({}));
    let undated = record(
        "h2",
        "undated_unresolved",
        json!({ "endingToPageId": null, "closeDate": null }),
    );
    let applied = record("h3", "applied", json!({}));
    let held = record("h4", "error", json!({ "detail": "held after 3 attempts" }));
    let open_error = record("h5", "error", json!({ "detail": "attempt 1" }));
    let filter = |v: Value| -> EdgeProposalCliFilter { de(v) };
    let list = |f: &EdgeProposalCliFilter, limit: f64| -> Vec<u64> {
        b.list_edge_proposal_cli_rows(f, limit)
            .unwrap()
            .iter()
            .map(|r| r["id"].as_u64().unwrap())
            .collect()
    };
    // Newest first; a status list, one id and one undated id narrow it; the limit cuts it.
    let all = filter(json!({ "kind": "all" }));
    assert_eq!(
        list(&all, 1000.0),
        vec![open_error, held, applied, undated, proposed]
    );
    assert_eq!(list(&all, 2.0), vec![open_error, held]);
    let open =
        filter(json!({ "kind": "statuses", "statuses": ["proposed", "undated_unresolved"] }));
    assert_eq!(list(&open, 50.0), vec![undated, proposed]);
    assert_eq!(
        list(&filter(json!({ "kind": "id", "id": applied })), 50.0),
        vec![applied]
    );
    assert_eq!(
        list(&filter(json!({ "kind": "undated", "id": applied })), 50.0),
        Vec::<u64>::new()
    );
    assert_eq!(
        list(&filter(json!({ "kind": "undated", "id": undated })), 50.0),
        vec![undated]
    );
    for bad in [0.0, 1001.0, 2.5] {
        assert_eq!(
            b.list_edge_proposal_cli_rows(&all, bad).unwrap_err().code,
            INVALID_ARGUMENT
        );
    }
    // The row: slugs for the pages, the date as text, REAL as Postgres prints it.
    let row = &b
        .list_edge_proposal_cli_rows(&filter(json!({ "kind": "id", "id": proposed })), 50.0)
        .unwrap()[0];
    assert_eq!(
        [
            &row["subject"],
            &row["a_target"],
            &row["b_target"],
            &row["ending"]
        ],
        [
            &json!("people/alice"),
            &json!("companies/acme"),
            &json!("companies/widget"),
            &json!("companies/acme")
        ]
    );
    assert_eq!(
        [&row["close_date"], &row["confidence"], &row["born_closed"]],
        [&json!("2025-03-01"), &json!(0.9), &json!(false)]
    );
    assert!(row["created_at"].as_str().unwrap().ends_with('Z'));
    let undated_row = &b
        .list_edge_proposal_cli_rows(&filter(json!({ "kind": "id", "id": undated })), 50.0)
        .unwrap()[0];
    assert_eq!(
        [&undated_row["ending"], &undated_row["close_date"]],
        [&Value::Null, &Value::Null]
    );

    assert_eq!(
        id_list(&b.list_applied_edge_proposal_ids().unwrap()),
        vec![applied]
    );
    // Only an error row is cleared by id; only the held one by --all-held.
    assert_eq!(
        id_list(&b.delete_edge_proposal_error(proposed as f64).unwrap()),
        Vec::<u64>::new()
    );
    assert_eq!(
        id_list(&b.delete_held_edge_proposal_errors().unwrap()),
        vec![held]
    );
    assert_eq!(
        id_list(&b.delete_held_edge_proposal_errors().unwrap()),
        Vec::<u64>::new()
    );
    assert_eq!(
        id_list(&b.delete_edge_proposal_error(open_error as f64).unwrap()),
        vec![open_error]
    );
    assert_eq!(
        id_list(&b.delete_edge_proposal_error(open_error as f64).unwrap()),
        Vec::<u64>::new()
    );
    // A cleared error frees its evidence: the pair can be recorded again.
    assert!(
        b.record_edge_proposal(&proposal(alice, acme, widget, "h4", "proposed"))
            .unwrap()
            .is_some()
    );

    assert_eq!(
        b.read_edge_proposal_source_id(undated as f64).unwrap(),
        Some("default".to_string())
    );
    assert_eq!(b.read_edge_proposal_source_id(987_654.0).unwrap(), None);
    b.mark_edge_proposal_dated(undated as f64).unwrap();
    let dated = &b
        .list_edge_proposal_cli_rows(&filter(json!({ "kind": "id", "id": undated })), 50.0)
        .unwrap()[0];
    assert_eq!(dated["status"], json!("rejected"));
    assert_eq!(
        list(&filter(json!({ "kind": "undated", "id": undated })), 50.0),
        Vec::<u64>::new()
    );
}
