//! The write journal: admission, idempotency, outstanding limits, receipts, local writers.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::journal::{
    FinishWrite, JournalLimits, PageMutation, Principal, WriteAdmission, WriterRegistration,
};
use gbrain_store::pages::ReadScope;
use gbrain_store::search::SearchOptions;
use serde_json::{Value, json};

const REQ_1: &str = "11111111-1111-4111-8111-111111111111";
const REQ_2: &str = "22222222-2222-4222-8222-222222222222";
const WRITER: &str = "33333333-3333-4333-8333-333333333333";

fn cli() -> Principal {
    Principal {
        kind: "local_cli".into(),
        id: "writer-1".into(),
    }
}

fn mutation(request: &str, slug: &str, body: &str, options: Value) -> PageMutation {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": "writer-1"},
        "requestId": request,
        "slug": slug,
        "page": {"type": "note", "title": slug, "compiled_truth": body},
        "options": options,
    }))
    .unwrap()
}

fn admission(request: &str, slug: &str, intent: Value) -> WriteAdmission {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": "writer-1"},
        "operation": "put_page",
        "requestId": request,
        "slug": slug,
        "callerIntent": intent,
    }))
    .unwrap()
}

fn page_slugs(store: &Store) -> Vec<String> {
    store
        .search_keyword("body", &SearchOptions::default())
        .unwrap()
        .iter()
        .map(|r| r["slug"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_submitted_page_write_commits_page_chunks_and_receipt_together() {
    let dir = TempDir::new("journal-submit");
    let store = open(&dir);
    let receipt = store
        .submit_page_mutation(
            &mutation(REQ_1, "People/Ada", "body of ada", json!({})),
            None,
        )
        .unwrap();
    assert_eq!(receipt["state"], "committed");
    assert_eq!(receipt["request_id"], REQ_1);
    assert_eq!(receipt["status"], "created");
    assert_eq!(receipt["slug"], "people/ada");
    assert_eq!(receipt["chunks"], 1);
    assert_eq!(receipt["outcome"]["page_id"], receipt["page_id"]);
    assert!(receipt.get("write_error").is_none());
    assert!(receipt["created_at"].as_str().unwrap().ends_with('Z'));
    let snapshot = store
        .read_page_snapshot("people/ada", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(snapshot["revision"], receipt["knowledge_revision"]);
    assert_eq!(page_slugs(&store), ["people/ada"]);
    // the stored request has the WriteRequest fields
    let row = store.get_write_request(&cli(), REQ_1).unwrap().unwrap();
    assert_eq!(row["state"], "committed");
    assert_eq!(row["operation"], "put_page");
    assert_eq!(row["source_id"], "default");
    assert_eq!(row["principal_kind"], "local_cli");
    assert_eq!(row["sequence"], 1);
    assert!(row["completed_at"].is_string());
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 0);
}

#[test]
fn repeating_a_request_returns_the_receipt_and_writes_nothing() {
    let dir = TempDir::new("journal-replay");
    let store = open(&dir);
    let m = mutation(REQ_1, "doc", "body once", json!({}));
    let first = store.submit_page_mutation(&m, None).unwrap();
    let again = store.submit_page_mutation(&m, None).unwrap();
    assert_eq!(first, again);
    assert_eq!(
        store
            .get_versions("doc", &Default::default())
            .unwrap()
            .len(),
        0
    );
    let row = store.get_write_request(&cli(), REQ_1).unwrap().unwrap();
    assert_eq!(row["sequence"], 1, "no second request was admitted");
    // another request id for the same content is a new write; the page is unchanged
    let next = store
        .submit_page_mutation(&mutation(REQ_2, "doc", "body once", json!({})), None)
        .unwrap();
    assert_eq!(next["status"], "unchanged");
    assert_eq!(
        store.get_write_request(&cli(), REQ_2).unwrap().unwrap()["sequence"],
        2
    );
}

#[test]
fn the_same_request_id_for_other_content_is_an_idempotency_conflict() {
    let dir = TempDir::new("journal-conflict");
    let store = open(&dir);
    store
        .submit_page_mutation(&mutation(REQ_1, "doc", "first body", json!({})), None)
        .unwrap();
    let err = store
        .submit_page_mutation(&mutation(REQ_1, "doc", "other body", json!({})), None)
        .unwrap_err();
    assert_eq!(err.code, IDEMPOTENCY_CONFLICT);
    let err = store
        .submit_page_mutation(&mutation(REQ_1, "elsewhere", "first body", json!({})), None)
        .unwrap_err();
    assert_eq!(err.code, IDEMPOTENCY_CONFLICT);
    assert_eq!(
        store
            .read_page_snapshot("doc", &ReadScope::default())
            .unwrap()
            .unwrap()["page"]["compiled_truth"],
        "first body"
    );
    // the same id under another principal is a different request
    let mut other = mutation(REQ_1, "doc", "other body", json!({}));
    other.principal.id = "writer-2".into();
    assert_eq!(
        store.submit_page_mutation(&other, None).unwrap()["state"],
        "committed"
    );
}

#[test]
fn an_update_keeps_a_version_of_what_it_replaced() {
    let dir = TempDir::new("journal-versions");
    let store = open(&dir);
    store
        .submit_page_mutation(&mutation(REQ_1, "doc", "body v1", json!({})), None)
        .unwrap();
    let receipt = store
        .submit_page_mutation(&mutation(REQ_2, "doc", "body v2", json!({})), None)
        .unwrap();
    assert_eq!(receipt["status"], "updated");
    let versions = store.get_versions("doc", &Default::default()).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0]["compiled_truth"], "body v1");
    assert_eq!(receipt["version_id"], versions[0]["id"]);
    assert_eq!(
        store
            .search_keyword("v2", &SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .search_keyword("v1", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_write_that_fails_on_its_own_terms_leaves_the_page_and_a_terminal_receipt() {
    let dir = TempDir::new("journal-failed");
    let store = open(&dir);
    store
        .submit_page_mutation(&mutation(REQ_1, "doc", "kept body", json!({})), None)
        .unwrap();
    // revision conflict
    let stale = mutation(
        REQ_2,
        "doc",
        "new body",
        json!({"expectedRevision": "00000000-0000-4000-8000-000000000000"}),
    );
    let receipt = store.submit_page_mutation(&stale, None).unwrap();
    assert_eq!(receipt["state"], "conflict");
    assert_eq!(receipt["write_error"], REVISION_CONFLICT);
    assert!(receipt["write_error_message"].is_string());
    assert_eq!(
        store
            .read_page_snapshot("doc", &ReadScope::default())
            .unwrap()
            .unwrap()["page"]["compiled_truth"],
        "kept body"
    );
    // repeating returns the same receipt even though the page could now be written
    assert_eq!(store.submit_page_mutation(&stale, None).unwrap(), receipt);
    // empty overwrite is a failure, not a conflict
    let blank = mutation("44444444-4444-4444-8444-444444444444", "doc", "", json!({}));
    let receipt = store.submit_page_mutation(&blank, None).unwrap();
    assert_eq!(receipt["state"], "failed");
    assert_eq!(receipt["write_error"], EMPTY_OVERWRITE);
    // a bad chunk source fails after the page was written inside the transaction: nothing stays
    let bad = mutation(
        "55555555-5555-4555-8555-555555555555",
        "fresh",
        "fresh body",
        json!({"chunks": [{"chunk_index": 0, "chunk_text": "x", "chunk_source": "nonsense"}]}),
    );
    let receipt = store.submit_page_mutation(&bad, None).unwrap();
    assert_eq!(receipt["state"], "failed");
    assert_eq!(receipt["write_error"], INVALID_ARGUMENT);
    assert!(
        store
            .read_page_snapshot("fresh", &ReadScope::default())
            .unwrap()
            .is_none()
    );
    assert_eq!(store.count_chunks().unwrap(), 1);
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 0);
}

#[test]
fn errors_before_admission_are_errors_and_leave_no_request() {
    let dir = TempDir::new("journal-preadmission");
    let store = open(&dir);
    let err = store
        .submit_page_mutation(&mutation(REQ_1, "../x", "body", json!({})), None)
        .unwrap_err();
    assert_eq!(err.code, INVALID_SLUG);
    let err = store
        .submit_page_mutation(
            &mutation(REQ_1, "doc", "body", json!({"sourceId": "nope"})),
            None,
        )
        .unwrap_err();
    assert_eq!(err.code, SOURCE_NOT_FOUND);
    let err = store
        .submit_page_mutation(&mutation("not-a-uuid", "doc", "body", json!({})), None)
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let mut bad_principal = mutation(REQ_1, "doc", "body", json!({}));
    bad_principal.principal.kind = "robot".into();
    assert_eq!(
        store
            .submit_page_mutation(&bad_principal, None)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    let mut changed = mutation(REQ_1, "doc", "body", json!({}));
    changed.source_incarnation = Some("old-incarnation".into());
    assert_eq!(
        store.submit_page_mutation(&changed, None).unwrap_err().code,
        SOURCE_CHANGED
    );
    assert!(store.get_write_request(&cli(), REQ_1).unwrap().is_none());
    assert_eq!(store.count_pages(None).unwrap(), 0);
    // no request id: the store mints one
    let mut minted = mutation(REQ_1, "doc", "body", json!({}));
    minted.request_id = None;
    let receipt = store.submit_page_mutation(&minted, None).unwrap();
    assert_eq!(receipt["request_id"].as_str().unwrap().len(), 36);
}

#[test]
fn unfinished_requests_are_limited_per_principal_and_per_brain() {
    let dir = TempDir::new("journal-limits");
    let store = open(&dir);
    let limits = JournalLimits {
        principal_outstanding: 2,
        brain_outstanding: 3,
    };
    let id = |n: u32| format!("00000000-0000-4000-8000-{n:012}");
    store
        .admit_write(&admission(&id(1), "a", json!({})), Some(limits))
        .unwrap();
    store
        .admit_write(&admission(&id(2), "b", json!({})), Some(limits))
        .unwrap();
    let err = store
        .admit_write(&admission(&id(3), "c", json!({})), Some(limits))
        .unwrap_err();
    assert_eq!(err.code, ADMISSION_REFUSED);
    let outstanding = store.journal_outstanding().unwrap();
    assert_eq!(outstanding["brain"], 2);
    assert_eq!(outstanding["principals"]["principal:local_cli:writer-1"], 2);
    // another principal still fits until the brain limit
    let mut other = admission(&id(4), "d", json!({}));
    other.principal.id = "writer-2".into();
    store.admit_write(&other, Some(limits)).unwrap();
    let mut third = admission(&id(5), "e", json!({}));
    third.principal.id = "writer-3".into();
    assert_eq!(
        store.admit_write(&third, Some(limits)).unwrap_err().code,
        ADMISSION_REFUSED
    );
    // admitting an admitted request again is not a new request
    store
        .admit_write(&admission(&id(1), "a", json!({})), Some(limits))
        .unwrap();
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 3);
    // finishing frees a slot
    let receipt = store
        .finish_write(
            &cli(),
            &id(1),
            &FinishWrite {
                state: "cancelled".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(receipt["state"], "cancelled");
    store
        .admit_write(&admission(&id(3), "c", json!({})), Some(limits))
        .unwrap();
    // a submitted write counts while it runs but not after: the limit never blocks finished work
    let tight = Some(JournalLimits {
        principal_outstanding: 1,
        brain_outstanding: 1,
    });
    let fresh = TempDir::new("journal-limits-2");
    let other_store = open(&fresh);
    for n in 0..5 {
        let m = mutation(&id(100 + n), &format!("p{n}"), "body", json!({}));
        assert_eq!(
            other_store.submit_page_mutation(&m, tight).unwrap()["state"],
            "committed"
        );
    }
}

#[test]
fn a_request_ends_once_and_only_in_a_terminal_state() {
    let dir = TempDir::new("journal-finish");
    let store = open(&dir);
    let queued = store
        .admit_write(&admission(REQ_1, "doc", json!({"a": 1})), None)
        .unwrap();
    assert_eq!(queued["state"], "queued");
    assert_eq!(queued["sequence"], 1);
    assert_eq!(queued["source_id"], "default");
    let receipt = store.get_write_receipt(&cli(), REQ_1).unwrap().unwrap();
    assert_eq!(receipt["state"], "queued");
    let bad = |state: &str| FinishWrite {
        state: state.into(),
        ..Default::default()
    };
    assert_eq!(
        store
            .finish_write(&cli(), REQ_1, &bad("running"))
            .unwrap_err()
            .code,
        INVALID_STATE
    );
    assert_eq!(
        store
            .finish_write(&cli(), REQ_1, &bad("bogus"))
            .unwrap_err()
            .code,
        INVALID_STATE
    );
    assert_eq!(
        store
            .finish_write(&cli(), REQ_2, &bad("committed"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    let done = store
        .finish_write(
            &cli(),
            REQ_1,
            &FinishWrite {
                state: "failed".into(),
                error_code: Some("boom".into()),
                blocked_reason: Some("why".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(done["state"], "failed");
    assert_eq!(done["write_error"], "boom");
    assert_eq!(done["blocked_reason"], "why");
    assert_eq!(
        store
            .finish_write(&cli(), REQ_1, &bad("committed"))
            .unwrap_err()
            .code,
        INVALID_STATE
    );
    // sequences keep counting
    let next = store
        .admit_write(&admission(REQ_2, "doc", json!({})), None)
        .unwrap();
    assert_eq!(next["sequence"], 2);
    // a client id that was not a UUID is kept and shown on the receipt
    let mut client = admission("66666666-6666-4666-8666-666666666666", "doc", json!({}));
    client.client_request_id = Some("my-own-id".into());
    store.admit_write(&client, None).unwrap();
    let receipt = store
        .get_write_receipt(&cli(), "66666666-6666-4666-8666-666666666666")
        .unwrap()
        .unwrap();
    assert_eq!(receipt["client_request_id"], "my-own-id");
}

#[test]
fn the_journal_survives_a_reopen() {
    let dir = TempDir::new("journal-reopen");
    let receipt = {
        let store = open(&dir);
        store
            .admit_write(&admission(REQ_2, "later", json!({})), None)
            .unwrap();
        let receipt = store
            .submit_page_mutation(&mutation(REQ_1, "doc", "durable body", json!({})), None)
            .unwrap();
        store.close();
        receipt
    };
    let store = open(&dir);
    assert_eq!(
        store
            .submit_page_mutation(&mutation(REQ_1, "doc", "durable body", json!({})), None)
            .unwrap(),
        receipt
    );
    assert_eq!(
        store.get_write_receipt(&cli(), REQ_2).unwrap().unwrap()["state"],
        "queued"
    );
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 1);
    let next = store
        .admit_write(
            &admission("77777777-7777-4777-8777-777777777777", "x", json!({})),
            None,
        )
        .unwrap();
    assert_eq!(next["sequence"], 3);
    assert_eq!(page_slugs(&store), ["doc"]);
}

#[test]
fn the_brain_has_an_identity() {
    let dir = TempDir::new("journal-identity");
    let id = {
        let store = open(&dir);
        let identity = store.get_brain_identity().unwrap();
        assert_eq!(identity["brain_id"], store.brain_id());
        identity["brain_id"].as_str().unwrap().to_string()
    };
    assert_eq!(
        open(&dir).get_brain_identity().unwrap()["brain_id"],
        id.as_str()
    );
}

fn writer(id: &str, lane: &str, hash: &str) -> WriterRegistration {
    serde_json::from_value(json!({"id": id, "lane": lane, "credentialHash": hash, "grantCeiling": {"scopes": ["read"]}})).unwrap()
}

#[test]
fn local_writers_register_once_and_mismatches_are_rejected() {
    let dir = TempDir::new("journal-writers");
    let store = open(&dir);
    assert!(store.read_local_writer(WRITER).unwrap().is_none());
    let row = store
        .register_local_writer(&writer(WRITER, "cli", "hash-a"))
        .unwrap();
    assert_eq!(row["lane"], "cli");
    assert_eq!(row["revoked_at"], Value::Null);
    assert_eq!(row["grant_ceiling"], json!({"scopes": ["read"]}));
    // idempotent
    assert_eq!(
        store
            .register_local_writer(&writer(WRITER, "cli", "hash-a"))
            .unwrap(),
        row
    );
    assert_eq!(store.read_local_writer(WRITER).unwrap().unwrap(), row);
    // another lane or credential under the same id
    assert_eq!(
        store
            .register_local_writer(&writer(WRITER, "stdio", "hash-a"))
            .unwrap_err()
            .code,
        WRITER_REJECTED
    );
    assert_eq!(
        store
            .register_local_writer(&writer(WRITER, "cli", "hash-b"))
            .unwrap_err()
            .code,
        WRITER_REJECTED
    );
    // the credential under another id
    let other = "44444444-4444-4444-8444-444444444444";
    assert_eq!(
        store
            .register_local_writer(&writer(other, "cli", "hash-a"))
            .unwrap_err()
            .code,
        WRITER_REJECTED
    );
    assert_eq!(
        store
            .register_local_writer(&writer("nope", "cli", "h"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store
            .register_local_writer(&writer(other, "web", "h"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store
            .register_local_writer(&writer(other, "cli", ""))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    // revoked: never replaced
    assert!(store.revoke_local_writer(WRITER).unwrap());
    assert!(store.read_local_writer(WRITER).unwrap().unwrap()["revoked_at"].is_string());
    assert_eq!(
        store
            .register_local_writer(&writer(WRITER, "cli", "hash-a"))
            .unwrap_err()
            .code,
        WRITER_REJECTED
    );
    assert!(!store.revoke_local_writer(other).unwrap());
    // survives a reopen
    store.close();
    let store = open(&dir);
    assert!(store.read_local_writer(WRITER).unwrap().unwrap()["revoked_at"].is_string());
}
