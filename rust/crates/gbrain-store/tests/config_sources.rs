//! Config and sources: what an empty brain answers, and the PGLite semantics of each method.

mod common;

use common::{TempDir, open};
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::sources::{ListSourcesOptions, SourceInput};
use gbrain_store::{DEFAULT_SCHEMA_VERSION, OpenOptions, Store};
use serde_json::json;

#[test]
fn an_empty_brain_reports_the_schema_version_and_nothing_else() {
    let dir = TempDir::new("cfg-empty");
    let store = open(&dir);
    assert_eq!(store.get_config("version").unwrap().as_deref(), Some("319"));
    assert_eq!(DEFAULT_SCHEMA_VERSION, 319);
    assert_eq!(store.info().schema_version, 319);
    let all = store.get_all_config().unwrap();
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(store.get_config("missing").unwrap(), None);
    assert_eq!(store.unset_config("missing").unwrap(), 0);
    assert_eq!(
        store.list_config_keys("nope.").unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn the_schema_version_comes_from_the_caller_on_a_fresh_brain_and_from_the_records_after() {
    let dir = TempDir::new("cfg-version");
    let path = dir.path().join("brain");
    let options = OpenOptions {
        schema_version: 400,
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&path, options).unwrap();
    assert_eq!(store.get_config("version").unwrap().as_deref(), Some("400"));
    store.set_config("version", "401").unwrap();
    store.close();
    // A later open with another default does not rewrite the brain's own version.
    let store = Store::open_dir(&path, OpenOptions::default()).unwrap();
    assert_eq!(store.info().schema_version, 401);
    assert_eq!(store.get_config("version").unwrap().as_deref(), Some("401"));
}

#[test]
fn set_replaces_unset_reports_rows_and_values_survive_a_reopen() {
    let dir = TempDir::new("cfg-set");
    let store = open(&dir);
    store.set_config("a", "1").unwrap();
    store.set_config("a", "2").unwrap();
    store.set_config("empty", "").unwrap();
    assert_eq!(store.get_config("a").unwrap().as_deref(), Some("2"));
    assert_eq!(store.get_config("empty").unwrap().as_deref(), Some(""));
    store.close();
    let store = open(&dir);
    assert_eq!(store.get_config("a").unwrap().as_deref(), Some("2"));
    assert_eq!(store.unset_config("a").unwrap(), 1);
    assert_eq!(store.unset_config("a").unwrap(), 0);
    assert_eq!(store.get_config("a").unwrap(), None);
}

#[test]
fn prefix_listing_is_literal_sorted_and_getall_has_everything() {
    let dir = TempDir::new("cfg-prefix");
    let store = open(&dir);
    for (k, v) in [
        ("sync.repo", "x"),
        ("sync.a", "1"),
        ("sync%b", "2"),
        ("sync_c", "3"),
        ("other", "4"),
    ] {
        store.set_config(k, v).unwrap();
    }
    assert_eq!(
        store.list_config_keys("sync.").unwrap(),
        ["sync.a", "sync.repo"]
    );
    assert_eq!(
        store.list_config_keys("sync%").unwrap(),
        ["sync%b"],
        "% is not a wildcard"
    );
    assert_eq!(
        store.list_config_keys("sync_").unwrap(),
        ["sync_c"],
        "_ is not a wildcard"
    );
    let all = store.get_all_config().unwrap();
    assert_eq!(all.len(), 6);
    assert_eq!(all["other"], "4");
    let keys: Vec<_> = all.keys().cloned().collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
}

#[test]
fn a_config_key_with_nul_is_refused() {
    let dir = TempDir::new("cfg-nul");
    let store = open(&dir);
    assert_eq!(
        store.set_config("a\0b", "x").unwrap_err().code,
        INVALID_ARGUMENT
    );
    assert_eq!(store.get_config("a\0b").unwrap_err().code, INVALID_ARGUMENT);
}

#[test]
fn a_fresh_brain_has_only_the_default_source_with_pglites_row_shape() {
    let dir = TempDir::new("src-default");
    let store = open(&dir);
    let sources = store
        .list_all_sources(&ListSourcesOptions::default())
        .unwrap();
    assert_eq!(sources.len(), 1);
    let row = serde_json::to_value(&sources[0]).unwrap();
    assert_eq!(row["id"], "default");
    assert_eq!(row["name"], "default");
    assert_eq!(row["local_path"], json!(null));
    assert_eq!(row["last_sync_at"], json!(null));
    assert_eq!(row["config"], json!({"federated": true}));
    assert_eq!(row["incarnation"].as_str().unwrap().len(), 36);
    let by_id = store.get_source_by_id("default").unwrap().unwrap();
    assert_eq!(by_id, sources[0]);
    assert_eq!(store.get_source_by_id("nope").unwrap(), None);
    // Local-path-only skips a pure-database source such as the default.
    let local = store
        .list_all_sources(&ListSourcesOptions {
            local_path_only: true,
            ..Default::default()
        })
        .unwrap();
    assert!(local.is_empty());
}

fn input(id: &str, local_path: Option<&str>) -> SourceInput {
    SourceInput {
        id: id.into(),
        name: Some(id.into()),
        local_path: local_path.map(String::from),
        ..Default::default()
    }
}

#[test]
fn sources_list_default_first_then_by_id_and_archived_ones_are_hidden() {
    let dir = TempDir::new("src-list");
    let store = open(&dir);
    store
        .upsert_source(&input("zeta", Some("/work/zeta")))
        .unwrap();
    store.upsert_source(&input("alpha", None)).unwrap();
    let ids = |options: ListSourcesOptions| -> Vec<String> {
        store
            .list_all_sources(&options)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect()
    };
    assert_eq!(ids(Default::default()), ["default", "alpha", "zeta"]);
    assert!(store.set_source_archived("alpha", true).unwrap());
    assert_eq!(ids(Default::default()), ["default", "zeta"]);
    assert_eq!(
        ids(ListSourcesOptions {
            include_archived: true,
            ..Default::default()
        }),
        ["default", "alpha", "zeta"]
    );
    assert_eq!(
        ids(ListSourcesOptions {
            local_path_only: true,
            ..Default::default()
        }),
        ["zeta"]
    );
    // The archived source still reads by id.
    assert!(store.get_source_by_id("alpha").unwrap().is_some());
    assert!(!store.set_source_archived("missing", true).unwrap());
}

#[test]
fn the_storage_shelf_is_not_a_local_path_source() {
    let dir = TempDir::new("src-shelf");
    let store = open(&dir);
    store
        .upsert_source(&input("shelf", Some("/shelf")))
        .unwrap();
    assert!(
        store
            .update_source_config(
                "shelf",
                json!({"role": "storage_manifest"}).as_object().unwrap()
            )
            .unwrap()
    );
    let local = store
        .list_all_sources(&ListSourcesOptions {
            local_path_only: true,
            ..Default::default()
        })
        .unwrap();
    assert!(local.is_empty());
}

#[test]
fn upsert_keeps_the_incarnation_and_updates_only_the_fields_given() {
    let dir = TempDir::new("src-upsert");
    let store = open(&dir);
    let first = store.upsert_source(&input("wiki", Some("/a"))).unwrap();
    let second = store
        .upsert_source(&SourceInput {
            id: "wiki".into(),
            last_sync_at: Some("2026-08-10T12:00:00.000123Z".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(second.incarnation, first.incarnation);
    assert_eq!(second.local_path.as_deref(), Some("/a"));
    assert_eq!(
        second.last_sync_at.as_deref(),
        Some("2026-08-10T12:00:00.000123Z")
    );
    let patch = json!({"a": 1, "federated": null});
    assert!(
        store
            .update_source_config("default", patch.as_object().unwrap())
            .unwrap()
    );
    let default = store.get_source_by_id("default").unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&default.config).unwrap(),
        json!({"a": 1, "federated": null}),
        "a null in a patch stays a JSON null, as `config || patch` leaves it"
    );
    assert!(
        !store
            .update_source_config("missing", &Default::default())
            .unwrap()
    );
}

#[test]
fn bad_source_ids_and_timestamps_are_refused() {
    let dir = TempDir::new("src-bad");
    let store = open(&dir);
    for id in ["", "Upper", "has space", "a\0b", &"x".repeat(33)] {
        let error = store.upsert_source(&input(id, None)).unwrap_err();
        assert_eq!(error.code, INVALID_ARGUMENT, "{id:?}");
    }
    let bad = SourceInput {
        id: "ok".into(),
        last_sync_at: Some("yesterday".into()),
        ..Default::default()
    };
    assert_eq!(
        store.upsert_source(&bad).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn sources_survive_a_reopen() {
    let dir = TempDir::new("src-reopen");
    let store = open(&dir);
    let made = store.upsert_source(&input("keep", Some("/k"))).unwrap();
    store.close();
    let store = open(&dir);
    assert_eq!(store.get_source_by_id("keep").unwrap().unwrap(), made);
    assert_eq!(
        store
            .list_all_sources(&ListSourcesOptions::default())
            .unwrap()
            .len(),
        2
    );
}
