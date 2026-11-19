//! The relational recall arm's seed admit read (`read_admitted_page_refs`): only the live pages the read
//! scope admits come back; a soft-deleted, quarantined, archived-source, other-source or private page never
//! leaks through, and a missing ref answers nothing.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::page_ops::{PageReadScope, PageRef};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put_in(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "company", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            ..Default::default()
        })
        .unwrap();
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    source(&store, "other");
    source(&store, "old");
    put_in(&store, "default", "companies/open", json!({}));
    put_in(
        &store,
        "default",
        "companies/private",
        json!({ "visibility": "private" }),
    );
    put_in(
        &store,
        "default",
        "companies/held",
        json!({ "quarantine": { "reason": "test" } }),
    );
    put_in(&store, "default", "companies/gone", json!({}));
    store
        .soft_delete_page("companies/gone", Some("default"))
        .unwrap();
    put_in(&store, "other", "companies/open", json!({}));
    put_in(&store, "old", "companies/archived", json!({}));
    store.set_source_archived("old", true).unwrap();
    store
}

fn r(source_id: &str, slug: &str) -> PageRef {
    PageRef {
        source_id: source_id.into(),
        slug: slug.into(),
    }
}

fn refs() -> Vec<PageRef> {
    vec![
        r("default", "companies/open"),
        r("default", "companies/private"),
        r("default", "companies/held"),
        r("default", "companies/gone"),
        r("default", "companies/missing"),
        r("other", "companies/open"),
        r("old", "companies/archived"),
    ]
}

fn admitted(store: &Store, scope: &PageReadScope) -> Vec<String> {
    store
        .read_admitted_page_refs(&refs(), scope)
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}:{}",
                row["source_id"].as_str().unwrap(),
                row["slug"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn the_scope_admits_only_live_pages_of_its_sources() {
    let dir = TempDir::new("relational-scoped");
    let store = seeded(&dir);
    let scoped = PageReadScope {
        source_id: Some("default".into()),
        ..Default::default()
    };
    assert_eq!(
        admitted(&store, &scoped),
        vec!["default:companies/open", "default:companies/private"]
    );
    let federated = PageReadScope {
        source_ids: Some(vec!["other".into(), "old".into()]),
        ..Default::default()
    };
    assert_eq!(admitted(&store, &federated), vec!["other:companies/open"]);
}

#[test]
fn the_privacy_policy_hides_private_pages() {
    let dir = TempDir::new("relational-private");
    let store = seeded(&dir);
    let hidden = PageReadScope {
        exclude_private: Some(PrivacyPolicy {
            honor_aliases: true,
            entity_privacy: true,
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        admitted(&store, &hidden),
        vec!["default:companies/open", "other:companies/open"]
    );
}

#[test]
fn no_refs_answer_nothing() {
    let dir = TempDir::new("relational-empty");
    let store = seeded(&dir);
    assert!(
        store
            .read_admitted_page_refs(&[], &PageReadScope::default())
            .unwrap()
            .is_empty()
    );
}
