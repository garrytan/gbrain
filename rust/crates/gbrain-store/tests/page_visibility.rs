//! Page visibility guards: whether the caller sees one page, and which of a list of pages it reads,
//! for the read policy and the member-access policy, live and soft-deleted pages.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::page_visibility::{CallerPageAccessRow, PageRef, WriteVisibilityProbe};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    put(&store, "notes/open", json!({}));
    put(&store, "notes/private", json!({"visibility": "private"}));
    put(
        &store,
        "notes/alice",
        json!({"readable_by": ["member:alice"]}),
    );
    put(&store, "notes/gone", json!({}));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    store
}

fn read_policy() -> PrivacyPolicy {
    PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    }
}

fn access_policy(identity: &[&str]) -> PrivacyPolicy {
    PrivacyPolicy {
        identity: identity.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

#[test]
fn hidden_judges_the_row_by_the_policy() {
    let dir = TempDir::new("visibility-hidden");
    let store = seeded(&dir);
    let hidden = |slug: &str, policy: &PrivacyPolicy| {
        store
            .read_page_hidden_from_caller("default", slug, policy)
            .unwrap()
    };
    assert!(!hidden("notes/open", &read_policy()));
    assert!(hidden("notes/private", &read_policy()));
    assert!(!hidden("notes/private", &access_policy(&[])));
    assert!(hidden("notes/alice", &access_policy(&[])));
    assert!(!hidden("notes/alice", &access_policy(&["member:alice"])));
    assert!(!hidden("notes/missing", &read_policy()));
    assert!(!hidden("notes/gone", &read_policy()));
    assert!(
        !store
            .read_page_hidden_from_caller("other", "notes/private", &read_policy())
            .unwrap()
    );
}

#[test]
fn access_names_each_page_row_once() {
    let dir = TempDir::new("visibility-access");
    let store = seeded(&dir);
    let pages: Vec<PageRef> = [
        "notes/open",
        "notes/private",
        "notes/alice",
        "notes/gone",
        "notes/missing",
        "notes/open",
    ]
    .iter()
    .map(|slug| PageRef {
        source_id: "default".into(),
        slug: (*slug).into(),
    })
    .collect();
    let row = |slug: &str, readable: bool| CallerPageAccessRow {
        source_id: "default".into(),
        slug: slug.into(),
        readable,
    };
    assert_eq!(
        store
            .read_caller_page_access(&pages, &read_policy())
            .unwrap(),
        [
            row("notes/alice", false),
            row("notes/gone", false),
            row("notes/open", true),
            row("notes/private", false),
        ]
    );
    assert_eq!(
        store
            .read_caller_page_access(&pages, &access_policy(&["member:alice"]))
            .unwrap(),
        [
            row("notes/alice", true),
            row("notes/gone", false),
            row("notes/open", true),
            row("notes/private", true),
        ]
    );
    assert!(
        store
            .read_caller_page_access(&[], &read_policy())
            .unwrap()
            .is_empty()
    );
}

fn source(store: &Store, id: &str, config: Value) {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": config })).unwrap();
    store.upsert_source(&input).unwrap();
}

fn probe(
    identity_may_open: Option<bool>,
    owner_only_source: bool,
    owner_only_any: bool,
) -> WriteVisibilityProbe {
    WriteVisibilityProbe {
        any_labelled: false,
        identity_may_open,
        owner_only_source,
        owner_only_any,
    }
}

#[test]
fn write_probe_names_what_an_identity_could_open() {
    let dir = TempDir::new("visibility-probe");
    let store = seeded(&dir);
    let read = |slug: &str| {
        store
            .read_write_visibility_probe("default", slug, &read_policy())
            .unwrap()
    };
    assert_eq!(read("notes/open"), probe(None, false, false));
    assert_eq!(read("notes/missing"), probe(None, false, false));
    assert_eq!(read("notes/private"), probe(Some(false), false, false));
    assert_eq!(read("notes/alice"), probe(Some(true), false, false));
}

#[test]
fn write_probe_reads_owner_only_sources() {
    let dir = TempDir::new("visibility-probe-owner");
    let store = seeded(&dir);
    let read = |source_id: &str| {
        store
            .read_write_visibility_probe(source_id, "notes/open", &read_policy())
            .unwrap()
    };
    source(&store, "plain", json!({ "owner_only": false }));
    assert_eq!(read("plain"), probe(None, false, false));
    source(&store, "chat", json!({ "kind": "imessage" }));
    assert_eq!(read("plain"), probe(None, false, true));
    assert_eq!(read("chat"), probe(None, true, true));
    source(&store, "flagged", json!({ "owner_only": "true" }));
    assert_eq!(read("flagged"), probe(None, true, true));
    assert_eq!(read("absent"), probe(None, false, true));
    // The owner-only test in its closed form: an owner-only source hides every page.
    assert_eq!(read("default"), probe(Some(false), false, true));
    assert!(
        store
            .read_page_hidden_from_caller("default", "notes/open", &read_policy())
            .unwrap()
    );
    let rows = store
        .read_caller_page_access(
            &[PageRef {
                source_id: "default".into(),
                slug: "notes/open".into(),
            }],
            &read_policy(),
        )
        .unwrap();
    assert!(!rows[0].readable);
}
