//! Page visibility guards: whether the caller sees one page, and which of a list of pages it reads,
//! for the read policy and the member-access policy, live and soft-deleted pages.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::{OwnerOnlyForm, PrivacyPolicy};
use gbrain_store::links::AddLinkOptions;
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
    // The owner-only test in its closed form (the policy's default): an owner-only source hides every page.
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

fn put_in(store: &Store, source: &str, slug: &str, page_type: &str) {
    let input: PageInput = serde_json::from_value(
        json!({"type": page_type, "title": slug, "compiled_truth": "body", "frontmatter": {}}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn form_policy(form: OwnerOnlyForm) -> PrivacyPolicy {
    PrivacyPolicy {
        owner_only: form,
        ..read_policy()
    }
}

#[test]
fn owner_only_forms_match_the_sql() {
    let dir = TempDir::new("visibility-owner-forms");
    let store = seeded(&dir);
    source(&store, "chat", json!({ "kind": "imessage" }));
    put_in(&store, "chat", "notes/message", "note");
    put_in(&store, "default", "concepts/lineage", "concept");
    put_in(&store, "default", "concepts/plain", "concept");
    put_in(&store, "default", "notes/linked-note", "note");
    let provenance = AddLinkOptions {
        link_type: Some("synthesized_from".into()),
        link_source: Some("concept-provenance".into()),
        to_source_id: Some("chat".into()),
        ..Default::default()
    };
    store
        .add_link("concepts/lineage", "notes/message", &provenance)
        .unwrap();
    // A note is not a concept or question, so its provenance link is not lineage.
    store
        .add_link("notes/linked-note", "notes/message", &provenance)
        .unwrap();
    let hidden = |source_id: &str, slug: &str, form: OwnerOnlyForm| {
        store
            .read_page_hidden_from_caller(source_id, slug, &form_policy(form))
            .unwrap()
    };
    for slug in ["notes/open", "concepts/plain", "notes/linked-note"] {
        assert!(hidden("default", slug, OwnerOnlyForm::Closed), "{slug}");
        assert!(!hidden("default", slug, OwnerOnlyForm::Fn), "{slug}");
        assert!(!hidden("default", slug, OwnerOnlyForm::Off), "{slug}");
    }
    assert!(hidden("default", "concepts/lineage", OwnerOnlyForm::Fn));
    assert!(!hidden("default", "concepts/lineage", OwnerOnlyForm::Off));
    assert!(hidden("chat", "notes/message", OwnerOnlyForm::Fn));
    assert!(hidden("chat", "notes/message", OwnerOnlyForm::Closed));
    assert!(!hidden("chat", "notes/message", OwnerOnlyForm::Off));
    // The member-access part alone (no privacy part) carries the test too.
    let access = PrivacyPolicy {
        owner_only: OwnerOnlyForm::Fn,
        ..access_policy(&[])
    };
    assert!(
        store
            .read_page_hidden_from_caller("chat", "notes/message", &access)
            .unwrap()
    );
    assert!(
        !store
            .read_page_hidden_from_caller("default", "notes/private", &access)
            .unwrap()
    );
}

#[test]
fn owner_only_form_reads_from_the_policy_json() {
    let policy: PrivacyPolicy = serde_json::from_value(
        json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn"}),
    )
    .unwrap();
    assert_eq!(policy.owner_only, OwnerOnlyForm::Fn);
    let policy: PrivacyPolicy =
        serde_json::from_value(json!({"honorAliases": true, "entityPrivacy": true})).unwrap();
    assert_eq!(policy.owner_only, OwnerOnlyForm::Closed);
    // Master's member names the fn form `lineage`.
    let policy: PrivacyPolicy = serde_json::from_value(
        json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage"}),
    )
    .unwrap();
    assert_eq!(policy.owner_only, OwnerOnlyForm::Fn);
    assert!(
        serde_json::from_value::<PrivacyPolicy>(
            json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "mode"})
        )
        .is_err()
    );
}

#[test]
fn the_open_form_hides_every_page_that_names_readers_and_reads_the_store_flag_for_origins() {
    let dir = TempDir::new("visibility-open");
    let store = seeded(&dir);
    let input: PageInput = serde_json::from_value(json!({
        "type": "atom", "title": "atom", "compiled_truth": "body",
        "frontmatter": {"source_slug": "notes/alice"}
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page("atoms/from-alice", &input, &opts).unwrap();
    let open = |identity: &[&str]| PrivacyPolicy {
        open: true,
        ..access_policy(identity)
    };
    let hidden = |slug: &str, policy: &PrivacyPolicy| {
        store
            .read_page_hidden_from_caller("default", slug, policy)
            .unwrap()
    };
    // The short form ignores the identity: a page that names readers is hidden from its own reader.
    assert!(hidden("notes/alice", &open(&["member:alice"])));
    assert!(!hidden("notes/alice", &access_policy(&["member:alice"])));
    assert!(!hidden("notes/open", &open(&[])));
    // The flag is set, so the origin walk still hides the atom derived from a page with readers.
    assert!(hidden("atoms/from-alice", &open(&[])));
    // With the flag unset by hand (the premise the short form trusts), the walk is skipped.
    store
        .set_config("access.restrictions_present", "0")
        .unwrap();
    assert!(!hidden("atoms/from-alice", &open(&[])));
    assert!(hidden("atoms/from-alice", &access_policy(&[])));
}
