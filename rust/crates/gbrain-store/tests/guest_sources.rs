//! `guest_sources.rs`: the guest source rows and the notes in them.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};

fn source(b: &Brain, id: &str, local_path: Option<&str>) {
    b.upsert_source(&SourceInput {
        id: id.into(),
        name: Some(id.into()),
        local_path: local_path.map(str::to_string),
        ..SourceInput::default()
    })
    .unwrap();
}

fn page(b: &Brain, source_id: &str, slug: &str) {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.into(),
        compiled_truth: slug.into(),
        ..PageInput::default()
    };
    b.put_page(
        slug,
        &input,
        &PutPageOptions {
            source_id: Some(source_id.into()),
            ..PutPageOptions::default()
        },
    )
    .unwrap();
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn the_first_write_keeps_the_writers_as_given_and_a_later_one_merges_by_byte() {
    let b = brain("guest-sources-merge");
    source(&b, "guest-a", None);
    let first = b
        .upsert_guest_source("guest-a", &names(&["ab"]), "external_untrusted")
        .unwrap();
    assert_eq!(first["source_id"], "guest-a");
    assert_eq!(first["writers"], serde_json::json!(["ab"]));
    // The conflict branch unions, de-duplicates and sorts by byte; the first ceiling stays.
    let second = b
        .upsert_guest_source("guest-a", &names(&["a/z", "a-z", "ab"]), "unknown")
        .unwrap();
    assert_eq!(second["writers"], serde_json::json!(["a-z", "a/z", "ab"]));
    assert_eq!(second["trust_ceiling"], "external_untrusted");
    let row = b.read_guest_source_row("guest-a").unwrap();
    assert_eq!(row.source_id.as_deref(), Some("guest-a"));
    assert_eq!(row.writers, Some(names(&["a-z", "a/z", "ab"])));
    assert!(!row.hidden);
}

#[test]
fn a_source_with_no_row_reads_none() {
    let b = brain("guest-sources-none");
    source(&b, "plain", None);
    assert_eq!(b.read_guest_source_row("plain").unwrap().source_id, None);
    assert_eq!(b.read_guest_source_row("missing").unwrap().source_id, None);
}

#[test]
fn a_row_needs_a_source_with_no_local_path_and_a_tier() {
    let b = brain("guest-sources-refusals");
    source(&b, "bound", Some("/tmp/repo"));
    source(&b, "free", None);
    let missing = b.upsert_guest_source("nope", &[], "unknown").unwrap_err();
    assert_eq!(missing.code, "constraint_violation");
    let bound = b.upsert_guest_source("bound", &[], "unknown").unwrap_err();
    assert!(bound.to_string().contains("guest_source_database_only"));
    let tier = b.upsert_guest_source("free", &[], "root").unwrap_err();
    assert_eq!(tier.code, "constraint_violation");
    assert_eq!(b.read_guest_source_row("free").unwrap().source_id, None);
    let nul = b
        .upsert_guest_source("free", &names(&["a\0b"]), "unknown")
        .unwrap_err();
    assert_eq!(nul.code, "invalid_argument");
}

#[test]
fn guest_notes_list_live_pages_of_rows_only_by_source_byte_order() {
    let b = brain("guest-sources-notes");
    for id in ["ab", "a0", "a-z", "plain", "gone"] {
        source(&b, id, None);
        page(&b, id, "shared");
    }
    for id in ["ab", "a0", "a-z", "gone"] {
        b.upsert_guest_source(id, &[], "external_untrusted")
            .unwrap();
    }
    b.soft_delete_page("shared", Some("gone")).unwrap();
    let ids = |rows: Vec<serde_json::Value>| -> Vec<String> {
        rows.iter()
            .map(|r| r["source_id"].as_str().unwrap().to_string())
            .collect()
    };
    // en_US would put `a0` before `a-z`; the byte order puts `a-z` first.
    assert_eq!(
        ids(b.list_guest_notes("shared", None).unwrap()),
        ["a-z", "a0", "ab"]
    );
    assert_eq!(
        ids(b.list_guest_notes("shared", Some("a0")).unwrap()),
        ["a0"]
    );
    assert!(
        b.list_guest_notes("shared", Some("plain"))
            .unwrap()
            .is_empty()
    );
    assert!(b.list_guest_notes("missing", None).unwrap().is_empty());
    assert!(b.list_guest_notes("a\0b", None).is_err());
}
