//! Writer release: the brain mode, the claim release, the counter add and the release reads of
//! `writerReleaseStore()` (rust/docs/store/persistence.md, "Writer release"), matched to the SQL
//! of `src/core/engine-sql/writer-release.ts`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{
    CounterDelta, HostBindingInsert, ReleaseRead, SourceBindingInsert, WorktreeInsert,
};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const HOST_A: &str = "00000000-0000-4000-8000-00000000000a";
const WORKTREE: &str = "e0000000-0000-4000-8000-0000000000e1";
const OTHER_WORKTREE: &str = "e0000000-0000-4000-8000-0000000000e2";

fn source(store: &Store, id: &str) -> String {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": {} })).unwrap();
    store.upsert_source(&input).unwrap().incarnation
}

fn bind(store: &Store, worktree_id: &str, source_id: &str, incarnation: &str, root: &str) {
    let worktree: WorktreeInsert = serde_json::from_value(
        json!({ "id": worktree_id, "ownerHostId": HOST_A, "ownerEpoch": 1 }),
    )
    .unwrap();
    store.insert_worktree(&worktree).unwrap();
    let host: HostBindingInsert = serde_json::from_value(json!({
        "worktreeId": worktree_id,
        "hostId": HOST_A,
        "localPath": root,
        "coordinationPath": format!("{root}-coord"),
    }))
    .unwrap();
    store.insert_host_binding(&host).unwrap();
    let binding: SourceBindingInsert = serde_json::from_value(json!({
        "sourceId": source_id,
        "incarnation": incarnation,
        "worktreeId": worktree_id,
        "relativePath": "notes",
    }))
    .unwrap();
    store.insert_source_binding(&binding).unwrap();
}

fn rows(store: &Store, what: Value) -> Value {
    let read: ReleaseRead = serde_json::from_value(what).unwrap();
    store.writer_release_rows(&read).unwrap()
}

fn admin_brain(store: &Store) -> Value {
    let state: Value = serde_json::from_str(&store.writer_admin_state_text().unwrap()).unwrap();
    state["brain"].clone()
}

#[test]
fn a_brain_is_classic_at_epoch_one_until_an_activation_moves_the_epoch() {
    let dir = TempDir::new("release-mode");
    let store = open(&dir);
    assert_eq!(
        rows(&store, json!({ "kind": "brain_mode" })),
        json!({ "enabled": false, "mode_epoch": "1" })
    );
    assert_eq!(store.set_brain_enabled(true).unwrap(), "2");
    assert_eq!(
        rows(&store, json!({ "kind": "brain_mode" })),
        json!({ "enabled": true, "mode_epoch": "2" })
    );
    // The writer admin state's brain row reports the stored mode, not a fixed classic row.
    let brain = admin_brain(&store);
    assert_eq!(brain["enabled"], true);
    assert_eq!(brain["mode_epoch"], 2);
    assert_eq!(brain["id"], store.brain_id());
    assert_eq!(store.set_brain_enabled(false).unwrap(), "3");
    drop(store);
    // The mode is stored: a reopened brain reads it back.
    let store = open(&dir);
    assert_eq!(
        rows(&store, json!({ "kind": "brain_mode" })),
        json!({ "enabled": false, "mode_epoch": "3" })
    );
}

#[test]
fn a_release_retires_the_named_worktrees_and_deletes_every_source_binding() {
    let dir = TempDir::new("release-bindings");
    let store = open(&dir);
    let work = source(&store, "work");
    let other = source(&store, "other");
    bind(&store, WORKTREE, "work", &work, "/var/tmp/r1");
    bind(&store, OTHER_WORKTREE, "other", &other, "/var/tmp/r2");
    assert_eq!(rows(&store, json!({ "kind": "source_binding_count" })), 2);
    assert_eq!(
        rows(&store, json!({ "kind": "live_bound_source_count" })),
        2
    );
    assert_eq!(
        rows(&store, json!({ "kind": "bound_source_ids" })),
        json!(["other", "work"])
    );
    assert_eq!(
        rows(&store, json!({ "kind": "claim_roots" })),
        json!([
            { "source_id": "other", "worktree_id": OTHER_WORKTREE, "root": "/var/tmp/r2" },
            { "source_id": "work", "worktree_id": WORKTREE, "root": "/var/tmp/r1" },
        ])
    );

    // Some: only the named worktree retires and loses its host binding; every source binding goes.
    store
        .release_worktree_bindings(Some(&[WORKTREE.to_uppercase()]))
        .unwrap();
    assert_eq!(rows(&store, json!({ "kind": "source_binding_count" })), 0);
    assert_eq!(
        rows(&store, json!({ "kind": "live_worktree_roots" })),
        json!([{ "id": OTHER_WORKTREE, "root": "/var/tmp/r2" }])
    );
    assert_eq!(
        rows(&store, json!({ "kind": "host_binding_roots" })),
        json!(["/var/tmp/r2"])
    );

    // None: every worktree retires and every host binding goes. The worktree rows are kept.
    store.release_worktree_bindings(None).unwrap();
    assert_eq!(
        rows(&store, json!({ "kind": "live_worktree_roots" })),
        json!([])
    );
    assert_eq!(
        rows(&store, json!({ "kind": "host_binding_roots" })),
        json!([])
    );
    let state: Value = serde_json::from_str(&store.writer_admin_state_text().unwrap()).unwrap();
    assert_eq!(
        state["worktrees"].as_array().map(Vec::len),
        Some(2),
        "{state}"
    );
}

#[test]
fn a_counter_add_changes_an_existing_row_and_refuses_below_zero() {
    let dir = TempDir::new("release-counters");
    let store = open(&dir);
    let key = vec!["brain".to_string()];
    let delta: CounterDelta =
        serde_json::from_value(json!({ "outstanding_count": 2, "intent_bytes": 10 })).unwrap();
    // A missing row changes nothing, as the UPDATE matches no row.
    store.add_persistence_counters("brain", &delta).unwrap();
    assert_eq!(store.read_counter_rows(&key).unwrap(), Vec::<Value>::new());

    store.lock_persistence_counters(&key).unwrap();
    store.add_persistence_counters("brain", &delta).unwrap();
    let row = &store.read_counter_rows(&key).unwrap()[0];
    assert_eq!(row["outstanding_count"], 2, "{row}");
    assert_eq!(row["intent_bytes"], 10, "{row}");
    assert_eq!(row["lifetime_ids"], 0, "{row}");

    let below: CounterDelta = serde_json::from_value(json!({ "outstanding_count": -3 })).unwrap();
    assert_eq!(
        store
            .add_persistence_counters("brain", &below)
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        store.read_counter_rows(&key).unwrap()[0]["outstanding_count"],
        2
    );
}

#[test]
fn the_audit_read_lists_live_markdown_pages_after_a_slug_in_byte_order() {
    let dir = TempDir::new("release-audit");
    let store = open(&dir);
    for slug in ["b", "ab", "a/z", "a-z"] {
        let input: PageInput = serde_json::from_value(
            json!({ "type": "note", "title": slug, "compiled_truth": "body", "timeline": "tl" }),
        )
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    }
    let audit = |after: &str, limit: usize| {
        rows(
            &store,
            json!({ "kind": "audit_pages", "sourceId": "default", "after": after, "limit": limit }),
        )
    };
    let slugs = |v: Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    };
    // Byte order: '-' (0x2d) before '/' (0x2f) before a letter, as COLLATE "C" sorts.
    assert_eq!(slugs(audit("", 10)), ["a-z", "a/z", "ab", "b"]);
    assert_eq!(slugs(audit("a/z", 2)), ["ab", "b"]);
    let first = &audit("", 1)[0];
    assert_eq!(first["database_only_reason"], Value::Null);
    let frontmatter = first["bytes"].as_u64().unwrap() as usize - "body".len() - "tl".len();
    assert!(frontmatter >= 2, "{first}");
    assert_eq!(audit("", 10)[0]["bytes"], first["bytes"]);
    assert_eq!(slugs(audit("", 0)), Vec::<String>::new());
    assert_eq!(
        rows(
            &store,
            json!({ "kind": "audit_pages", "sourceId": "nope", "after": "", "limit": 10 })
        ),
        json!([])
    );
}

#[test]
fn a_fresh_brain_has_no_retired_deactivations_and_no_blockers() {
    let dir = TempDir::new("release-empty");
    let store = open(&dir);
    for kind in [
        "retired_deactivations",
        "recovering_topology_changes",
        "live_leases",
        "configured_sources",
    ] {
        let got = rows(&store, json!({ "kind": kind }));
        if kind == "configured_sources" {
            assert_eq!(got.as_array().unwrap().len(), 1, "{kind}: {got}");
            assert_eq!(got[0]["id"], "default", "{kind}: {got}");
        } else {
            assert_eq!(got, json!([]), "{kind}");
        }
    }
    assert_eq!(
        rows(&store, json!({ "kind": "has_recovering_effect" })),
        false
    );
    assert_eq!(
        rows(&store, json!({ "kind": "blocking_requests", "limit": 5 })),
        json!([])
    );
}

#[test]
fn an_unknown_read_kind_is_refused_by_the_decoder() {
    assert!(serde_json::from_value::<ReleaseRead>(json!({ "kind": "nope" })).is_err());
}
