//! Leases across reopen, and how a brain comes to run in multi-user mode (I-0): from the caller's switch or from the
//! brain's own config row, per brain. `GBRAIN_RUST_CONCURRENT_WRITES=1` runs the plain opens on the concurrent store.

mod common;

use common::TempDir;
use gbrain_store::leases::{LeaseToken, lost_reason};
use gbrain_store::write_origin::WriteOrigin;
use gbrain_store::{MULTIUSER_CONFIG_KEY, OpenOptions, Store};

fn origin(host: &str) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("{host}-host"),
        incarnation: format!("{host}-incarnation"),
        writer_id: "local_cli:test".into(),
    }
}

fn open_with(dir: &TempDir, multiuser: bool) -> Store {
    let options = OpenOptions {
        concurrent_writes: std::env::var("GBRAIN_RUST_CONCURRENT_WRITES").is_ok_and(|v| v == "1"),
        multiuser,
        ..OpenOptions::default()
    };
    Store::open_dir(&dir.path().join("brain"), options).unwrap()
}

#[test]
fn a_lease_epoch_survives_a_reopen_and_the_next_taker_gets_a_higher_one() {
    let dir = TempDir::new("leases-reopen");
    let store = common::open(&dir);
    let a = store
        .acquire_lease("consumer:h1", &origin("a"), 60_000)
        .unwrap()
        .unwrap();
    store.release_lease(&a).unwrap();
    let b = store
        .acquire_lease("consumer:h1", &origin("b"), 60_000)
        .unwrap()
        .unwrap();
    store.close();
    let store = common::open(&dir);
    assert_eq!(store.read_lease("consumer:h1").unwrap().unwrap().epoch, 2);
    store.assert_lease(&b).unwrap();
    let e = store.assert_lease(&a).unwrap_err();
    assert_eq!(lost_reason(&e).as_deref(), Some("epoch_moved"));
    store.release_lease(&b).unwrap();
    let c = store
        .acquire_lease("consumer:h1", &origin("c"), 60_000)
        .unwrap()
        .unwrap();
    assert_eq!(c.epoch, 3);
}

#[test]
fn multi_user_mode_comes_from_the_caller_or_from_the_brain_s_own_config_row() {
    // Off: neither the switch nor the row. The open info is what it always was.
    let off = TempDir::new("mu-off");
    let store = open_with(&off, false);
    assert!(!store.multiuser());
    let info = serde_json::to_value(store.info()).unwrap();
    assert!(info.get("multiuser").is_none(), "{info}");
    assert_eq!(
        store.occ_stats().is_some(),
        std::env::var("GBRAIN_RUST_CONCURRENT_WRITES").is_ok_and(|v| v == "1")
    );
    store.close();

    // The caller's switch: multi-user, on the concurrent store.
    let switched = TempDir::new("mu-switch");
    let store = open_with(&switched, true);
    assert!(store.multiuser());
    assert!(
        store.occ_stats().is_some(),
        "multi-user mode implies concurrent writes"
    );
    assert_eq!(
        serde_json::to_value(store.info()).unwrap()["multiuser"],
        true
    );

    // Config only: the row turns it on at the next open, with the switch off.
    let configured = TempDir::new("mu-config");
    let store = open_with(&configured, false);
    assert!(!store.multiuser());
    store.set_config(MULTIUSER_CONFIG_KEY, "true").unwrap();
    store.close();
    let store = open_with(&configured, false);
    assert!(store.multiuser());
    assert!(store.occ_stats().is_some());

    // Two brains open in one process keep their own mode.
    let other = open_with(&off, false);
    assert!(store.multiuser() && !other.multiuser());

    // A protected write with no fence refuses only on the multi-user brain.
    let token = store
        .acquire_lease("n", &origin("a"), 60_000)
        .unwrap()
        .unwrap();
    assert_eq!(token.epoch, 1);
    let missing = LeaseToken {
        name: "n".into(),
        epoch: 9,
        token: "x".into(),
    };
    assert_eq!(
        lost_reason(&store.assert_lease(&missing).unwrap_err()).as_deref(),
        Some("epoch_moved")
    );

    // Unset again: off at the next open.
    store.unset_config(MULTIUSER_CONFIG_KEY).unwrap();
    store.close();
    assert!(!open_with(&configured, false).multiuser());
}

/// The clock floor is brain state: a snapshot copy of a multi-user brain carries the high-water mark with the data, and
/// a refused open (a writable open while another handle holds the brain) changes nothing, the floor included.
#[test]
fn a_snapshot_carries_the_clock_floor_and_a_refused_open_leaves_it_alone() {
    let dir = TempDir::new("leases-floor");
    let store = open_with(&dir, true);
    store
        .acquire_lease("n", &origin("a"), 60_000)
        .unwrap()
        .unwrap();
    let floor = store.clock_high_water().unwrap();
    assert!(floor >= store.read_lease("n").unwrap().unwrap().acquired_at_us);
    let refused = Store::open_dir(
        &dir.path().join("brain"),
        OpenOptions {
            multiuser: true,
            ..OpenOptions::default()
        },
    );
    assert!(refused.is_err(), "a second writable open is refused");
    assert_eq!(store.clock_high_water().unwrap(), floor);
    let target = dir.path().join("copy");
    store
        .snapshot_to(&target, &gbrain_store::snapshot::SnapshotOp::new())
        .unwrap();
    store.close();
    let copy = Store::open_dir_read_only(&target).unwrap();
    assert_eq!(copy.clock_high_water().unwrap(), floor);
    drop(copy);
    let reopened = open_with(&dir, true);
    assert_eq!(reopened.clock_high_water().unwrap(), floor);
}
