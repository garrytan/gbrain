//! The propose_takes failure tombstones (take_proposals.rs): recording is idempotent per claim,
//! a listing is by page slug bytes, filtered to unacted `rejected` rows with the claim prefix,
//! and a source's rows leave with the source.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::sources::SourceInput;
use gbrain_store::take_proposals::FailureTombstoneInput;

const PREFIX: &str = "(extraction failed: ";

fn input(source: &str, slug: &str, claim: &str) -> FailureTombstoneInput {
    FailureTombstoneInput {
        source_id: source.into(),
        slug: slug.into(),
        content_hash: "h".into(),
        prompt_version: "v1".into(),
        proposal_run_id: "run".into(),
        claim_text: claim.into(),
        model_id: "m".into(),
    }
}

fn claim(code: &str) -> String {
    format!("{PREFIX}{code})")
}

#[test]
fn lists_by_slug_bytes_and_records_each_claim_once() {
    let dir = TempDir::new("take-proposals-list");
    let store = open(&dir);
    for slug in ["notes/b", "Notes/a", "notes/B", "notes/a"] {
        assert!(
            store
                .record_failure_tombstone(&input("default", slug, &claim("llm_error")))
                .unwrap()
        );
    }
    assert!(
        !store
            .record_failure_tombstone(&input("default", "notes/a", &claim("llm_error")))
            .unwrap()
    );
    // Another claim for the same page is its own row; a claim without the prefix is not listed.
    assert!(
        store
            .record_failure_tombstone(&input("default", "notes/a", &claim("timeout")))
            .unwrap()
    );
    assert!(
        store
            .record_failure_tombstone(&input("default", "notes/c", "a plain claim"))
            .unwrap()
    );
    let rows = store.list_failure_tombstones("default", PREFIX).unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r.page_slug.as_str()).collect();
    assert_eq!(
        slugs,
        ["Notes/a", "notes/B", "notes/a", "notes/a", "notes/b"]
    );
    assert_eq!(rows[0].prompt_version, "v1");
    assert_eq!(rows[0].claim_text, claim("llm_error"));
    // `proposed_at` is `timestamptz::text`.
    assert!(
        rows[0].proposed_at.ends_with("+00"),
        "{}",
        rows[0].proposed_at
    );
}

#[test]
fn an_unknown_source_refuses_and_a_source_removal_takes_its_rows() {
    let dir = TempDir::new("take-proposals-source");
    let store: Store = open(&dir);
    let err = store
        .record_failure_tombstone(&input("nowhere", "notes/a", &claim("llm_error")))
        .unwrap_err();
    assert_eq!(err.code, gbrain_store::error::SOURCE_NOT_FOUND);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            name: Some("other".into()),
            local_path: Some("/brains/other".into()),
            ..SourceInput::default()
        })
        .unwrap();
    store
        .record_failure_tombstone(&input("other", "notes/a", &claim("llm_error")))
        .unwrap();
    store
        .record_failure_tombstone(&input("default", "notes/a", &claim("llm_error")))
        .unwrap();
    assert_eq!(
        store
            .list_failure_tombstones("other", PREFIX)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .list_failure_tombstones("default", PREFIX)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list_failure_tombstones("absent", PREFIX)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_nul_byte_refuses() {
    let dir = TempDir::new("take-proposals-nul");
    let store = open(&dir);
    let err = store
        .record_failure_tombstone(&input("default", "notes/\0a", &claim("llm_error")))
        .unwrap_err();
    assert_eq!(err.code, gbrain_store::error::INVALID_ARGUMENT);
}
