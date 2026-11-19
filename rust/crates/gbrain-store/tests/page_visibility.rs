//! Page visibility guards: whether the caller sees one page, and which of a list of pages it reads,
//! for the read policy and the member-access policy, live and soft-deleted pages.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::page_visibility::{CallerPageAccessRow, PageRef};
use gbrain_store::pages::{PageInput, PutPageOptions};
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
    put(&store, "notes/alice", json!({"readable_by": ["member:alice"]}));
    put(&store, "notes/gone", json!({}));
    store.soft_delete_page("notes/gone", Some("default")).unwrap();
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
        store.read_caller_page_access(&pages, &read_policy()).unwrap(),
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
