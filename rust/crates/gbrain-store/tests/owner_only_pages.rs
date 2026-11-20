//! The owner-only rule of the `excludePrivate` page policy (`ownerOnlyPageSql`,
//! src/core/access/owner-only.ts): with an owner-only source in the brain, a non-owner read
//! hides that source's pages and every concept or question synthesized from one of them in the
//! `fn` form, and hides every page in the closed form. With no owner-only source, the rule
//! hides nothing.

mod common;

use common::TempDir;
use gbrain_store::facts::{OwnerOnlyForm, PrivacyPolicy};
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageFilters, PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Map, Value, json};
use std::sync::Arc;

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
    let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    (dir, store)
}

fn source(store: &Store, id: &str, config: Value) {
    let config: Map<String, Value> = serde_json::from_value(config).unwrap();
    store
        .upsert_source(&SourceInput {
            id: id.to_string(),
            name: Some(id.to_string()),
            config: Some(config),
            ..SourceInput::default()
        })
        .unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str, page_type: &str) {
    let input: PageInput = serde_json::from_value(json!({
        "type": page_type, "title": slug, "compiled_truth": format!("body of {slug}"),
        "frontmatter": {"visibility": "world"},
    }))
    .unwrap();
    let options: PutPageOptions =
        serde_json::from_value(json!({"sourceId": source_id, "index": false})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn synthesized_from(store: &Store, from: &str, to_source: &str, to: &str) {
    let options = AddLinkOptions {
        link_type: Some("synthesized_from".into()),
        link_source: Some("concept-provenance".into()),
        to_source_id: Some(to_source.into()),
        ..AddLinkOptions::default()
    };
    store.add_link(from, to, &options).unwrap();
}

/// The `source:slug` keys a slug-sorted read of both sources returns, with `limit`.
fn read(store: &Store, form: OwnerOnlyForm, limit: Option<usize>) -> Vec<String> {
    let filters = PageFilters {
        sort: Some("slug".into()),
        limit,
        source_ids: Some(vec!["default".into(), "own-texts".into()]),
        exclude_private: Some(PrivacyPolicy {
            owner_only: form,
            ..PrivacyPolicy::default()
        }),
        ..PageFilters::default()
    };
    store
        .list_pages(&filters)
        .unwrap()
        .iter()
        .map(|p| {
            format!(
                "{}:{}",
                p["source_id"].as_str().unwrap(),
                p["slug"].as_str().unwrap()
            )
        })
        .collect()
}

fn fixture(store: &Store, own_config: Value) {
    source(store, "own-texts", own_config);
    // The owner-only page sorts first, so a read that filtered after its limit would come up short.
    page(store, "own-texts", "a/thread", "note");
    page(store, "default", "a/thread", "note");
    page(store, "default", "b/from-texts", "concept");
    page(store, "default", "b/question-from-texts", "question");
    page(store, "default", "c/open", "note");
    page(store, "default", "d/plain-concept", "concept");
    synthesized_from(store, "b/from-texts", "own-texts", "a/thread");
    synthesized_from(store, "b/question-from-texts", "own-texts", "a/thread");
}

const ALL: [&str; 6] = [
    "default:a/thread",
    "own-texts:a/thread",
    "default:b/from-texts",
    "default:b/question-from-texts",
    "default:c/open",
    "default:d/plain-concept",
];

#[test]
fn fn_form_hides_owner_only_pages_and_their_concepts_before_the_limit() {
    let (_dir, store) = brain("owner-only-lineage");
    fixture(&store, json!({"owner_only": true}));
    let kept = [
        "default:a/thread",
        "default:c/open",
        "default:d/plain-concept",
    ];
    assert_eq!(read(&store, OwnerOnlyForm::Fn, None), kept);
    assert_eq!(read(&store, OwnerOnlyForm::Fn, Some(2)), kept[..2]);
    // The owner's rendering carries no owner-only conjunct, so every page stays.
    assert_eq!(read(&store, OwnerOnlyForm::Off, None), ALL);
}

#[test]
fn an_imessage_source_is_owner_only() {
    let (_dir, store) = brain("owner-only-imessage");
    fixture(&store, json!({"kind": "imessage"}));
    assert_eq!(
        read(&store, OwnerOnlyForm::Fn, None),
        [
            "default:a/thread",
            "default:c/open",
            "default:d/plain-concept"
        ]
    );
}

#[test]
fn closed_form_hides_every_page_while_an_owner_only_source_exists() {
    let (_dir, store) = brain("owner-only-closed");
    fixture(&store, json!({"owner_only": true}));
    assert!(read(&store, OwnerOnlyForm::Closed, None).is_empty());
}

#[test]
fn no_owner_only_source_hides_nothing() {
    let (_dir, store) = brain("owner-only-none");
    fixture(&store, json!({"owner_only": false}));
    assert_eq!(read(&store, OwnerOnlyForm::Closed, None), ALL);
    assert_eq!(read(&store, OwnerOnlyForm::Fn, None), ALL);
}
