//! Link preparation's slug reads (`readLiveSlugAliases`, `readSourceSlugProbe`) and the source config, name and
//! federation-warning members. Expected rows follow the SQL in src/core/engine-sql/link-slug-reads.ts, sources.ts and
//! federation-exposure.ts.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Map, json};

fn put(store: &Store, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({ "type": "note", "title": slug, "compiled_truth": "body" }))
            .unwrap();
    let options: PutPageOptions =
        serde_json::from_value(json!({ "sourceId": "default", "index": false })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

#[test]
fn a_live_alias_needs_no_page_of_its_own_and_a_live_canonical_page() {
    let dir = TempDir::new("lsr-alias");
    let store = open(&dir);
    put(&store, "people/old");
    store.update_slug("people/old", "people/new", None).unwrap();
    let rows = store
        .read_live_slug_aliases(
            "default",
            &[
                "people/old".into(),
                "people/none".into(),
                "people/old".into(),
            ],
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].alias_slug.as_str(), rows[0].canonical_slug.as_str()),
        ("people/old", "people/new")
    );
    // A live page at the alias slug wins over the alias.
    put(&store, "people/old");
    assert!(
        store
            .read_live_slug_aliases("default", &["people/old".into()])
            .unwrap()
            .is_empty()
    );
    // A soft-deleted canonical page makes the alias dead.
    store
        .soft_delete_page("people/old", Some("default"))
        .unwrap();
    store
        .soft_delete_page("people/new", Some("default"))
        .unwrap();
    assert!(
        store
            .read_live_slug_aliases("default", &["people/old".into()])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_slug_probe_sums_per_slug_hashes_so_new_pages_add_to_the_old_hash() {
    let dir = TempDir::new("lsr-probe");
    let store = open(&dir);
    let empty = store.read_source_slug_probe("default", 0).unwrap();
    assert_eq!(
        (empty.count, empty.max_id, empty.hash.as_str()),
        (0, 0, "0")
    );
    put(&store, "notes/a");
    put(&store, "notes/b");
    let first = store.read_source_slug_probe("default", 0).unwrap();
    assert_eq!(first.count, 2);
    assert_eq!(first.added, ["notes/a", "notes/b"]);
    assert_eq!(first.hash, first.added_hash);
    put(&store, "notes/c");
    let next = store
        .read_source_slug_probe("default", first.max_id)
        .unwrap();
    assert_eq!(next.count, 3);
    assert_eq!(next.added, ["notes/c"]);
    let sum = first.hash.parse::<i128>().unwrap() + next.added_hash.parse::<i128>().unwrap();
    assert_eq!(next.hash, sum.to_string());
    // A soft-deleted page still counts, as the SQL reads every row of the source.
    store.soft_delete_page("notes/a", Some("default")).unwrap();
    assert_eq!(store.read_source_slug_probe("default", 0).unwrap().count, 3);
}

#[test]
fn replace_config_and_rename_change_only_a_known_source() {
    let dir = TempDir::new("lsr-config");
    let store = open(&dir);
    let mut config = Map::new();
    config.insert("federated".into(), json!(false));
    config.insert("keep_me".into(), json!("yes"));
    assert!(store.replace_source_config("default", &config).unwrap());
    assert_eq!(store.get_source("default").unwrap().unwrap().config, config);
    assert!(!store.replace_source_config("missing", &config).unwrap());
    assert!(store.rename_source("default", "Display").unwrap());
    assert_eq!(
        store
            .get_source("default")
            .unwrap()
            .unwrap()
            .name
            .as_deref(),
        Some("Display")
    );
    assert!(!store.rename_source("missing", "X").unwrap());
}

#[test]
fn an_unwritten_source_exposes_no_page_to_a_federation() {
    let dir = TempDir::new("lsr-exposure");
    let store = open(&dir);
    put(&store, "notes/local");
    assert!(
        store
            .read_federation_exposed_pages("default", true, true)
            .unwrap()
            .is_empty()
    );
}
