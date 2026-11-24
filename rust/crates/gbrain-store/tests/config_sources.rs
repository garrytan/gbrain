//! Config and sources: what an empty brain answers, and the PGLite semantics of each method.

mod common;

use common::{TempDir, open};
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::sources::{
    ListSourcesOptions, SourceInput, SourceSyncStampOptions, SyncCheckpointAdvance,
};
use gbrain_store::{DEFAULT_SCHEMA_VERSION, OpenOptions, Store};
use serde_json::json;

#[test]
fn an_empty_brain_reports_the_schema_version_and_nothing_else() {
    let dir = TempDir::new("cfg-empty");
    let store = open(&dir);
    assert_eq!(store.get_config("version").unwrap().as_deref(), Some("319"));
    assert_eq!(DEFAULT_SCHEMA_VERSION, 319);
    assert_eq!(store.info().schema_version, 319);
    // A fresh brain also holds the two keys migrations v226 and v227 write on an empty PGLite or Postgres brain: the trust
    // backfill is done and the write gate's scan baseline is at zero (rust/docs/store/cli-reads-doctor-facts-trust.md).
    let all = store.get_all_config().unwrap();
    assert_eq!(
        all.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "trust.backfill_completed_at",
            "version",
            "write_gate.scan_baseline"
        ],
        "{all:?}"
    );
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
fn a_fresh_brain_records_the_write_gate_scan_baseline_under_the_callers_detector() {
    let dir = TempDir::new("cfg-baseline");
    let path = dir.path().join("brain");
    let options = OpenOptions {
        write_gate_detector_version: Some(2),
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&path, options).unwrap();
    // The text Postgres prints for the jsonb migration v227 stores on an empty brain.
    let baseline = r#"{"until": {"facts": 0, "pages": 0, "takes": 0, "timeline_entries": 0}, "detector_version": 2}"#;
    assert_eq!(
        store
            .get_config("write_gate.scan_baseline")
            .unwrap()
            .as_deref(),
        Some(baseline)
    );
    store.close();
    // A later open with another detector does not rewrite it, and a brain opened without one records it under
    // the default detector.
    let options = OpenOptions {
        write_gate_detector_version: Some(3),
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&path, options).unwrap();
    assert_eq!(
        store
            .get_config("write_gate.scan_baseline")
            .unwrap()
            .as_deref(),
        Some(baseline)
    );
    let plain = TempDir::new("cfg-default-baseline");
    let other = open(&plain);
    assert_eq!(
        other
            .get_config("write_gate.scan_baseline")
            .unwrap()
            .as_deref(),
        Some(baseline)
    );
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
    assert_eq!(all.len(), 8);
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

#[test]
fn the_sync_anchor_advances_one_source_and_survives_a_reopen() {
    let dir = TempDir::new("src-anchor");
    let store = open(&dir);
    store.upsert_source(&input("wiki", None)).unwrap();
    store.upsert_source(&input("other", None)).unwrap();
    assert_eq!(store.get_source("wiki").unwrap().unwrap().last_commit, None);
    store
        .advance_source_commit("wiki", "c1", Some(Some("2026-01-02T03:04:05.000Z")))
        .unwrap();
    store.advance_source_commit("wiki", "c2", None).unwrap();
    store
        .attach_source_path("wiki", "/srv/wiki", None, None)
        .unwrap();
    // An unknown source changes nothing, as the UPDATE matches no row.
    store.advance_source_commit("missing", "c9", None).unwrap();
    store
        .attach_source_path("missing", "/srv/missing", None, None)
        .unwrap();
    assert!(
        store
            .advance_source_commit("wiki", "c3", Some(Some("not a time")))
            .is_err()
    );
    store.close();
    let store = open(&dir);
    let wiki = store.get_source("wiki").unwrap().unwrap();
    assert_eq!(wiki.last_commit.as_deref(), Some("c2"));
    assert!(wiki.last_sync_at.is_some());
    assert_eq!(wiki.local_path.as_deref(), Some("/srv/wiki"));
    let records = store.list_source_records().unwrap();
    let newest = |id: &str| {
        records
            .iter()
            .find(|r| r.id == id)
            .and_then(|r| r.newest_content_at.clone())
    };
    assert_eq!(
        newest("wiki").as_deref(),
        Some("2026-01-02T03:04:05.000000Z")
    );
    store
        .advance_source_commit("wiki", "c4", Some(None))
        .unwrap();
    assert_eq!(
        store
            .list_source_records()
            .unwrap()
            .iter()
            .find(|r| r.id == "wiki")
            .unwrap()
            .newest_content_at,
        None
    );
    assert_eq!(
        store.get_source("other").unwrap().unwrap().last_commit,
        None
    );
    assert_eq!(store.get_source("missing").unwrap(), None);
    assert_eq!(
        store
            .read_plain_sync_source("wiki")
            .unwrap()
            .unwrap()
            .last_commit
            .as_deref(),
        Some("c4")
    );
}

#[test]
fn mark_source_synced_sets_only_the_last_sync_time_and_an_unknown_source_is_false() {
    let dir = TempDir::new("src-synced");
    let store = open(&dir);
    store.upsert_source(&input("dept", Some("/d"))).unwrap();
    let before = store.get_source("dept").unwrap().unwrap();
    assert_eq!(before.last_sync_at, None);
    assert!(
        store
            .mark_source_synced("dept", &Default::default())
            .unwrap()
    );
    let after = store.get_source("dept").unwrap().unwrap();
    let stamped = after.last_sync_at.clone().expect("the stamp is set");
    assert!(stamped.ends_with('Z'), "an ISO timestamp: {stamped}");
    // Only the sync time moved.
    assert_eq!(
        gbrain_store::sources::SourceDetailRow {
            last_sync_at: None,
            ..after
        },
        before
    );
    assert!(
        !store
            .mark_source_synced("missing", &Default::default())
            .unwrap()
    );
    assert!(store.get_source("missing").unwrap().is_none());
    store.close();
    let store = open(&dir);
    assert_eq!(
        store.get_source("dept").unwrap().unwrap().last_sync_at,
        Some(stamped)
    );
}

#[test]
fn a_fresh_brain_records_the_callers_initial_config_and_a_reopen_keeps_its_own() {
    let dir = TempDir::new("cfg-initial");
    let path = dir.path().join("brain");
    let options = OpenOptions {
        initial_config: vec![
            ("embedding_model".into(), "acme:embed-1".into()),
            ("embedding_dimensions".into(), "1024".into()),
        ],
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&path, options).unwrap();
    assert_eq!(
        store.get_config("embedding_model").unwrap().as_deref(),
        Some("acme:embed-1")
    );
    assert_eq!(
        store.get_config("embedding_dimensions").unwrap().as_deref(),
        Some("1024")
    );
    store.close();
    // A reopen with another identity does not rewrite the rows the brain was created with.
    let other = OpenOptions {
        initial_config: vec![("embedding_model".into(), "other:model".into())],
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&path, other).unwrap();
    assert_eq!(
        store.get_config("embedding_model").unwrap().as_deref(),
        Some("acme:embed-1")
    );
    store.close();
    // With no initial config a fresh brain has no embedding identity of its own.
    let bare = dir.path().join("bare");
    let store = Store::open_dir(&bare, OpenOptions::default()).unwrap();
    assert_eq!(store.get_config("embedding_model").unwrap(), None);
}

#[test]
fn initial_config_refuses_the_version_key() {
    let dir = TempDir::new("cfg-initial-version");
    let options = OpenOptions {
        initial_config: vec![("version".into(), "1".into())],
        ..OpenOptions::default()
    };
    let Err(err) = Store::open_dir(&dir.path().join("brain"), options) else {
        panic!("a version row in initial config must be refused");
    };
    assert_eq!(err.code, gbrain_store::error::INVALID_ARGUMENT);
}

#[test]
fn the_purge_epoch_advances_one_source_and_survives_a_reopen() {
    let dir = TempDir::new("src-purge-epoch");
    let store = open(&dir);
    store.upsert_source(&input("wiki", None)).unwrap();
    assert_eq!(store.read_source_purge_epoch("wiki").unwrap(), Some(0));
    assert_eq!(store.advance_source_purge_epoch("wiki").unwrap(), Some(1));
    assert_eq!(store.advance_source_purge_epoch("wiki").unwrap(), Some(2));
    // An unknown source changes nothing and returns no row, as the UPDATE ... RETURNING does.
    assert_eq!(store.advance_source_purge_epoch("missing").unwrap(), None);
    assert_eq!(store.read_source_purge_epoch("missing").unwrap(), None);
    assert_eq!(store.read_source_purge_epoch("default").unwrap(), Some(0));
    let before = store.get_source("wiki").unwrap();
    drop(store);
    let store = open(&dir);
    assert_eq!(store.read_source_purge_epoch("wiki").unwrap(), Some(2));
    assert_eq!(store.get_source("wiki").unwrap(), before);
}

#[test]
fn mark_source_synced_with_an_incarnation_stamps_only_that_incarnation_and_refuses_a_malformed_id()
{
    let dir = TempDir::new("src-synced-inc");
    let store = open(&dir);
    store.upsert_source(&input("dept", Some("/d"))).unwrap();
    let incarnation = store.get_source_by_id("dept").unwrap().unwrap().incarnation;
    let with = |id: &str| SourceSyncStampOptions {
        incarnation: Some(id.to_string()),
        newest_content_at: None,
    };
    assert!(
        !store
            .mark_source_synced("dept", &with("f0000000-0000-4000-8000-000000000000"))
            .unwrap()
    );
    assert_eq!(
        store.get_source("dept").unwrap().unwrap().last_sync_at,
        None
    );
    assert!(
        store
            .mark_source_synced("dept", &with(&incarnation.to_uppercase()))
            .unwrap()
    );
    assert!(
        store
            .get_source("dept")
            .unwrap()
            .unwrap()
            .last_sync_at
            .is_some()
    );
    let err = store
        .mark_source_synced("dept", &with("not-a-uuid"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn mark_source_synced_with_a_newest_content_time_sets_it_and_null_keeps_it() {
    let dir = TempDir::new("src-synced-newest");
    let store = open(&dir);
    store.upsert_source(&input("feed", Some("/f"))).unwrap();
    let newest = |store: &Store| {
        store
            .list_source_records()
            .unwrap()
            .into_iter()
            .find(|r| r.id == "feed")
            .and_then(|r| r.newest_content_at)
    };
    let with = |at: Option<&str>| SourceSyncStampOptions {
        incarnation: None,
        newest_content_at: at.map(str::to_string),
    };
    assert!(
        store
            .mark_source_synced("feed", &with(Some("2026-03-04T05:06:07.000Z")))
            .unwrap()
    );
    assert_eq!(
        newest(&store).as_deref(),
        Some("2026-03-04T05:06:07.000000Z")
    );
    assert!(store.mark_source_synced("feed", &with(None)).unwrap());
    assert_eq!(
        newest(&store).as_deref(),
        Some("2026-03-04T05:06:07.000000Z")
    );
    assert!(
        store
            .mark_source_synced("feed", &with(Some("2026-05-06T09:08:09+02:00")))
            .unwrap()
    );
    assert_eq!(
        newest(&store).as_deref(),
        Some("2026-05-06T07:08:09.000000Z")
    );
    let err = store
        .mark_source_synced("feed", &with(Some("not a time")))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!(
        newest(&store).as_deref(),
        Some("2026-05-06T07:08:09.000000Z")
    );
}

#[test]
fn the_sync_checkpoint_advances_only_from_its_commit_and_keeps_a_pinned_mode() {
    let dir = TempDir::new("src-checkpoint");
    let store = open(&dir);
    store.upsert_source(&input("repo", Some("/r"))).unwrap();
    let incarnation = store.get_source_by_id("repo").unwrap().unwrap().incarnation;
    let run = |commit: &str, from: Option<&str>, accept: bool, mode: &str, keep: bool| {
        store
            .advance_sync_checkpoint(&SyncCheckpointAdvance {
                source_id: "repo".into(),
                incarnation: incarnation.clone(),
                commit: Some(commit.into()),
                from: from.map(str::to_string),
                accept_at_commit: accept,
                slug_mode: mode.into(),
                keep_pinned_slug_mode: keep,
            })
            .unwrap()
    };
    assert_eq!(run("c1", None, false, "git-root", false)["advanced"], true);
    let source = store.get_source("repo").unwrap().unwrap();
    assert_eq!(source.last_commit.as_deref(), Some("c1"));
    assert_eq!(source.config["slug_root_mode"], "git-root");
    // No live page: newest_content_at stays empty.
    assert!(
        store
            .list_source_records()
            .unwrap()
            .iter()
            .find(|r| r.id == "repo")
            .unwrap()
            .newest_content_at
            .is_none()
    );
    // A moved checkpoint changes nothing.
    assert_eq!(
        run("c2", Some("c0"), false, "git-root", false)["advanced"],
        false
    );
    assert_eq!(
        run("c1", Some("c0"), true, "git-root", false)["advanced"],
        true
    );
    // A pinned mode refuses another mode and names itself; an empty scope keeps it.
    let refused = run("c3", Some("c1"), false, "source-root", false);
    assert_eq!(refused["advanced"], false);
    assert_eq!(refused["pinnedSlugMode"], "git-root");
    assert_eq!(
        run("c3", Some("c1"), false, "source-root", true)["advanced"],
        true
    );
    let source = store.get_source("repo").unwrap().unwrap();
    assert_eq!(source.last_commit.as_deref(), Some("c3"));
    assert_eq!(source.config["slug_root_mode"], "git-root");
}

#[test]
fn a_first_sync_slice_restamps_a_null_checkpoint_and_a_null_commit_never_matches_at_commit() {
    let dir = TempDir::new("src-checkpoint-null");
    let store = open(&dir);
    store.upsert_source(&input("repo", Some("/r"))).unwrap();
    let incarnation = store.get_source_by_id("repo").unwrap().unwrap().incarnation;
    let run = |commit: Option<&str>, from: Option<&str>, accept: bool| {
        store
            .advance_sync_checkpoint(&SyncCheckpointAdvance {
                source_id: "repo".into(),
                incarnation: incarnation.clone(),
                commit: commit.map(str::to_string),
                from: from.map(str::to_string),
                accept_at_commit: accept,
                slug_mode: "git-root".into(),
                keep_pinned_slug_mode: false,
            })
            .unwrap()
    };
    // A first sync's unfinished slice: the checkpoint stays NULL, stamped, as `last_commit = NULL` does on Postgres.
    assert_eq!(run(None, None, false)["advanced"], true);
    let source = store.get_source("repo").unwrap().unwrap();
    assert_eq!(source.last_commit, None);
    assert!(source.last_sync_at.is_some());
    // Past the first commit, a NULL commit with accept_at_commit does not match (`last_commit = NULL` is never true).
    assert_eq!(run(Some("c1"), None, false)["advanced"], true);
    assert_eq!(run(None, Some("c0"), true)["advanced"], false);
    assert_eq!(
        store
            .get_source("repo")
            .unwrap()
            .unwrap()
            .last_commit
            .as_deref(),
        Some("c1")
    );
}
