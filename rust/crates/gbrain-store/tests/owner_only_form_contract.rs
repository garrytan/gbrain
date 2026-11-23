//! The wire contract of `ownerOnly` in a store privacy policy (`OwnerOnlyForm` in owner_only.rs,
//! `StoreOwnerOnlyForm` in src/core/rust-engine/store-members/private-provenance.ts).
//!
//! The field is one of three forms, never optional: `off` (the rendered text holds no owner-only
//! test), `fn` (the v320 lineage function) or `closed` (any owner-only source hides every row).
//! Master's member (`StoreOwnerOnly` in its private-provenance.ts) names the function form
//! `lineage`, so `lineage` reads as `fn`. A policy that leaves the field out takes `closed`, so a
//! caller that forgets it hides more, never less. Any other value, `null` included, is refused
//! before the store reads.
//!
//! The policies here are built from JSON only, as the TypeScript member sends them, so the test
//! pins what reaches the store and not how the Rust type spells it.

mod common;

use common::TempDir;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageFilters, PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Map, Value, json};
use std::sync::Arc;

const OWN: &str = "own-texts";

/// A brain with an owner-only source holding `a/thread`, and in `default` the pages `a/thread`,
/// `b/from-texts` (a concept synthesized from the owner-only thread) and `c/open`.
fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
    let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    let config: Map<String, Value> = serde_json::from_value(json!({"owner_only": true})).unwrap();
    store
        .upsert_source(&SourceInput {
            id: OWN.to_string(),
            name: Some(OWN.to_string()),
            config: Some(config),
            ..SourceInput::default()
        })
        .unwrap();
    for (source_id, slug, page_type) in [
        (OWN, "a/thread", "note"),
        ("default", "a/thread", "note"),
        ("default", "b/from-texts", "concept"),
        ("default", "c/open", "note"),
    ] {
        let input: PageInput = serde_json::from_value(json!({
            "type": page_type, "title": slug, "compiled_truth": format!("body of {slug}"),
            "frontmatter": {"visibility": "world"},
        }))
        .unwrap();
        let options: PutPageOptions =
            serde_json::from_value(json!({"sourceId": source_id, "index": false})).unwrap();
        store.put_page(slug, &input, &options).unwrap();
    }
    let link = AddLinkOptions {
        link_type: Some("synthesized_from".into()),
        link_source: Some("concept-provenance".into()),
        to_source_id: Some(OWN.into()),
        ..AddLinkOptions::default()
    };
    store.add_link("b/from-texts", "a/thread", &link).unwrap();
    (dir, store)
}

/// The policy the member would send, with `owner_only` as the `ownerOnly` field (`None`: left out).
fn policy(owner_only: Option<Value>) -> Result<PrivacyPolicy, String> {
    let mut wire = json!({"honorAliases": false, "entityPrivacy": false});
    if let Some(value) = owner_only {
        wire["ownerOnly"] = value;
    }
    serde_json::from_value(wire).map_err(|e| e.to_string())
}

/// The `source:slug` keys a slug-sorted page read of both sources returns under `policy`.
fn read(store: &Store, policy: PrivacyPolicy) -> Vec<String> {
    let filters = PageFilters {
        sort: Some("slug".into()),
        source_ids: Some(vec!["default".into(), OWN.into()]),
        exclude_private: Some(policy),
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

#[test]
fn a_policy_without_owner_only_hides_every_page_while_an_owner_only_source_exists() {
    let (_dir, store) = brain("owner-only-form-absent");
    assert_eq!(read(&store, policy(None).unwrap()), Vec::<String>::new());
    assert_eq!(read(&store, PrivacyPolicy::default()), Vec::<String>::new());
}

#[test]
fn each_named_form_reads_as_its_own_test() {
    let (_dir, store) = brain("owner-only-form-named");
    let named = |form: &str| read(&store, policy(Some(json!(form))).unwrap());
    assert_eq!(
        named("off"),
        [
            "default:a/thread",
            "own-texts:a/thread",
            "default:b/from-texts",
            "default:c/open"
        ]
    );
    assert_eq!(named("fn"), ["default:a/thread", "default:c/open"]);
    assert_eq!(
        named("lineage"),
        named("fn"),
        "master's name for the fn form"
    );
    assert_eq!(named("closed"), Vec::<String>::new());
}

#[test]
fn any_other_owner_only_value_is_refused() {
    for value in [
        json!(null),
        json!("Lineage"),
        json!("mode"),
        json!("Closed"),
        json!(""),
        json!(true),
    ] {
        let got = policy(Some(value.clone()));
        assert!(got.is_err(), "ownerOnly {value} was accepted: {got:?}");
    }
}
