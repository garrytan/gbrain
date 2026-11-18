//! The page-write reads (write_misc.rs): a source's state and the live link-endpoint pages.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn source(store: &Store, id: &str, config: Value) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            local_path: Some(format!("/brains/{id}")),
            config: config.as_object().cloned(),
            ..SourceInput::default()
        })
        .unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str, page_type: &str) {
    let input = PageInput {
        page_type: page_type.into(),
        title: slug.to_uppercase(),
        compiled_truth: format!("body of {slug}"),
        ..PageInput::default()
    };
    let options = PutPageOptions {
        source_id: Some(source_id.into()),
        ..PutPageOptions::default()
    };
    store.put_page(slug, &input, &options).unwrap();
}

#[test]
fn source_state_reads_incarnation_archived_path_and_config() {
    let dir = TempDir::new("write-misc-source-state");
    let store = open(&dir);
    source(
        &store,
        "alpha",
        json!({ "mirror_read_only": true, "slug_root_mode": "strip" }),
    );
    store.set_source_archived("alpha", true).unwrap();
    let state = store.read_source_state("alpha").unwrap().unwrap();
    assert_eq!(state.incarnation.len(), 36);
    assert!(state.archived);
    assert_eq!(state.local_path.as_deref(), Some("/brains/alpha"));
    assert_eq!(
        Value::Object(state.config),
        json!({ "mirror_read_only": true, "slug_root_mode": "strip" })
    );
    let default = store.read_source_state("default").unwrap().unwrap();
    assert!(!default.archived);
    assert_eq!(default.local_path, None);
    assert!(store.read_source_state("nope").unwrap().is_none());
    assert!(store.read_source_state("bad\0id").unwrap().is_none());
}

fn keys(rows: &[gbrain_store::write_misc::LinkEndpointPageRow]) -> Vec<(String, String, String)> {
    rows.iter()
        .map(|r| (r.source_id.clone(), r.slug.clone(), r.page_type.clone()))
        .collect()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_string()).collect()
}

#[test]
fn link_endpoints_read_own_pages_then_other_sources_for_missing_and_cross_slugs() {
    let dir = TempDir::new("write-misc-link-endpoints");
    let store = open(&dir);
    source(&store, "alpha", json!({}));
    source(&store, "beta", json!({}));
    page(&store, "default", "people/ann", "person");
    page(&store, "default", "deals/x", "deal");
    page(&store, "alpha", "people/ann", "note");
    page(&store, "alpha", "people/bob", "person");
    page(&store, "beta", "people/bob", "note");
    page(&store, "beta", "deals/x", "note");
    store.soft_delete_page("deals/x", Some("beta")).unwrap();

    // ann is own (no ref); bob is missing in default (a ref); deals/x is own and also a cross slug.
    let rows = store
        .list_link_endpoint_pages(
            "default",
            &strings(&["people/ann", "people/bob", "deals/x", "people/ann"]),
            &strings(&["deals/x"]),
        )
        .unwrap();
    assert_eq!(
        keys(&rows),
        vec![
            ("default".into(), "deals/x".into(), "deal".into()),
            ("default".into(), "people/ann".into(), "person".into()),
            ("alpha".into(), "people/bob".into(), "person".into()),
            ("beta".into(), "people/bob".into(), "note".into()),
        ]
    );
    assert!(rows.iter().all(|r| r.knowledge_revision.len() == 36));

    // Every slug is own and none is a cross slug: no other source is read.
    let own_only = store
        .list_link_endpoint_pages("alpha", &strings(&["people/ann"]), &[])
        .unwrap();
    assert_eq!(
        keys(&own_only),
        vec![("alpha".into(), "people/ann".into(), "note".into())]
    );

    assert!(
        store
            .list_link_endpoint_pages("alpha", &[], &[])
            .unwrap()
            .is_empty()
    );
}
