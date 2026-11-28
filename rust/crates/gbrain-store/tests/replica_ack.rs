//! Replica acks (`replica.rs`), the replica mark and the promotion's detach notes (`diverged_tail.rs`,
//! `follower.rs`): rust/docs/store/commit-log.md, "Replica acks". Every case runs with the primary on the
//! single-writer and the optimistic store. Fail-first: none of these compiled on e28c821e6c (no
//! `attach_replica`, `wait_replicated`, `note_primary_acked`, `PromotionNote::acked_seen`).

mod common;

use common::TempDir;
use gbrain_store::commit_log::{CommitPosition, LogOp, Timeline};
use gbrain_store::diverged_tail::DIVERGED_TAIL;
use gbrain_store::error::{INVALID_ARGUMENT, INVALID_STATE};
use gbrain_store::follower::{Follower, OldPrimaryStopped, PromotionNote, promotion_key};
use gbrain_store::replica::{
    REPLICATION_TIMEOUT, ReplicaAckSettings, ReplicaDetach, is_replica_key, replica_detach_key,
    replica_key,
};
use gbrain_store::snapshot::SnapshotOp;
use gbrain_store::takeover::TakeoverSettings;
use gbrain_store::{MultiUserWrites, OpenOptions, Store};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const HOST: &str = "d0000000-0000-4000-8000-0000000000d2";
const MODES: [bool; 2] = [false, true];

fn mu(concurrent: bool) -> OpenOptions {
    OpenOptions {
        concurrent_writes: concurrent,
        keyword_index_builder: false,
        multiuser: true,
        multiuser_writes: MultiUserWrites {
            commit_log: true,
            write_origin: true,
            host_id: Some(HOST.into()),
            log_retention_bytes: None,
        },
        ..OpenOptions::default()
    }
}

fn settings(timeout_ms: u64, max_waiters: usize) -> ReplicaAckSettings {
    ReplicaAckSettings {
        timeout_ms,
        max_waiters,
    }
}

fn promote(follower: Follower, concurrent: bool) -> Store {
    let stopped = OldPrimaryStopped::attest("test: the primary was dropped").unwrap();
    follower
        .promote_with(
            mu(concurrent),
            Arc::new(gbrain_store::SystemEnv),
            &TakeoverSettings::default(),
            Some(&stopped),
        )
        .unwrap()
}

fn catch_up(follower: &Follower, primary: &Store) {
    loop {
        let page = primary.read_commit_log(follower.cursor(), 50).unwrap();
        if page.records.is_empty() {
            return;
        }
        follower.apply_page(&page).unwrap();
    }
}

/// Writes one config key and returns the commit's position.
fn write(store: &Store, key: &str, value: &str) -> CommitPosition {
    store.set_config(key, value).unwrap();
    store.last_commit_position().unwrap()
}

/// Spins until `cond` holds (bounded; no fixed sleep).
fn until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::yield_now();
    }
}

struct Pair {
    _dir: TempDir,
    root: PathBuf,
    primary: Store,
    follower: Follower,
    generation: u64,
}

/// A primary with follower `f1` attached and caught up.
fn pair(name: &str, concurrent: bool) -> Pair {
    let dir = TempDir::new(name);
    let root = dir.path().to_path_buf();
    let primary = Store::open_dir(&root.join("primary"), mu(concurrent)).unwrap();
    primary.set_config("test.seed", "1").unwrap();
    primary
        .snapshot_to(&root.join("snap"), &SnapshotOp::new())
        .unwrap();
    let follower = Follower::open(&root.join("follower")).unwrap();
    follower.install_snapshot(&root.join("snap"), None).unwrap();
    let rec = primary.attach_replica("f1").unwrap();
    catch_up(&follower, &primary);
    primary
        .report_replica_ack("f1", rec.generation, follower.cursor().unwrap(), None)
        .unwrap();
    Pair {
        _dir: dir,
        root,
        primary,
        follower,
        generation: rec.generation,
    }
}

fn note_of(store: &Store) -> (PromotionNote, Vec<(Vec<u8>, LogOp)>) {
    let page = store.read_commit_log(None, usize::MAX).unwrap();
    let id = &page.lineage.last().unwrap().id;
    let key = promotion_key(id);
    let record = page
        .records
        .iter()
        .find(|r| r.ops.iter().any(|(k, _)| *k == key))
        .unwrap();
    let Some((_, LogOp::Put(value))) = record.ops.iter().find(|(k, _)| *k == key) else {
        panic!("the promotion note is not a put");
    };
    (serde_json::from_slice(value).unwrap(), record.ops.clone())
}

/// Fail-first #1: an acked write is in the promoted replica; a write the primary answered without the ack is
/// `replication_timeout`, never success.
#[test]
fn every_write_a_replica_acked_survives_its_attested_promotion() {
    for concurrent in MODES {
        let p = pair("ra-promote", concurrent);
        p.primary.set_replica_ack_settings(settings(50, 8));
        let acked = write(&p.primary, "test.acked", "saved");
        catch_up(&p.follower, &p.primary);
        p.primary
            .report_replica_ack("f1", p.generation, p.follower.cursor().unwrap(), None)
            .unwrap();
        let cover = p.primary.wait_replicated(acked).unwrap();
        assert!(cover.required && cover.covered);
        p.follower.note_primary_acked(acked).unwrap();
        // The follower stops; the next write is durable on the primary but is never answered as saved.
        let lost = write(&p.primary, "test.unacked", "unknown");
        let err = p.primary.wait_replicated(lost).unwrap_err();
        assert_eq!(err.code, REPLICATION_TIMEOUT, "{err}");
        assert_eq!(
            p.primary.get_config("test.unacked").unwrap().as_deref(),
            Some("unknown"),
            "the commit is durable on the primary"
        );
        let Pair {
            primary, follower, ..
        } = p;
        drop(primary);
        let promoted = promote(follower, concurrent);
        assert_eq!(
            promoted.get_config("test.acked").unwrap().as_deref(),
            Some("saved"),
            "concurrent {concurrent}"
        );
        assert_eq!(promoted.get_config("test.unacked").unwrap(), None);
        // The note records the mark the follower heard, and the promotion detached f1 in the same commit.
        let (note, ops) = note_of(&promoted);
        assert_eq!(note.acked_seen, Some(acked));
        assert!(
            ops.iter()
                .any(|(k, op)| *k == replica_key("f1") && matches!(op, LogOp::Delete))
        );
        let detach = ops
            .iter()
            .find_map(|(k, op)| match op {
                LogOp::Put(v) if *k == replica_detach_key("f1") => {
                    Some(serde_json::from_slice::<ReplicaDetach>(v).unwrap())
                }
                _ => None,
            })
            .expect("the promotion writes f1's detach note");
        assert_eq!(detach.reason, format!("promoted {}", note.timeline));
        assert!(promoted.attached_replicas().unwrap().is_empty());
        // Promote, then write: nothing to wait for (F11).
        let next = write(&promoted, "test.after", "x");
        let cover = promoted.wait_replicated(next).unwrap();
        assert!(!cover.required);
    }
}

/// Fail-first #2: a stopped follower ends the wait with `replication_timeout` and the commit stays.
#[test]
fn a_stopped_follower_ends_the_wait_with_replication_timeout() {
    for concurrent in MODES {
        let p = pair("ra-stopped", concurrent);
        p.primary.set_replica_ack_settings(settings(30, 8));
        let at = write(&p.primary, "test.k", "v");
        let started = Instant::now();
        let err = p.primary.wait_replicated(at).unwrap_err();
        assert_eq!(err.code, REPLICATION_TIMEOUT);
        assert!(err.message.contains(&at.token()), "{err}");
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert_eq!(p.primary.replica_waiters(), 0);
        assert_eq!(
            p.primary.get_config("test.k").unwrap().as_deref(),
            Some("v")
        );
        // The follower comes back and acks: the same position is covered now.
        catch_up(&p.follower, &p.primary);
        p.primary
            .report_replica_ack("f1", p.generation, p.follower.cursor().unwrap(), None)
            .unwrap();
        assert!(p.primary.wait_replicated(at).unwrap().covered);
    }
}

/// Fail-first #3: a detach ends every wait on the replica at once, writes go on, and the detach is a log record.
#[test]
fn a_detach_ends_the_waits_writes_go_on_and_the_detach_is_a_log_record() {
    for concurrent in MODES {
        let p = pair("ra-detach", concurrent);
        p.primary.set_replica_ack_settings(settings(600_000, 64));
        let at = write(&p.primary, "test.k", "v");
        std::thread::scope(|s| {
            let waits: Vec<_> = (0..40)
                .map(|_| s.spawn(|| p.primary.wait_replicated(at)))
                .collect();
            until("40 waiters", || p.primary.replica_waiters() == 40);
            // F7: reads answer while 40 waits run.
            assert_eq!(
                p.primary.get_config("test.k").unwrap().as_deref(),
                Some("v")
            );
            assert!(
                p.primary
                    .detach_replica("f1", "operator: follower retired")
                    .unwrap()
            );
            for w in waits {
                let err = w.join().unwrap().unwrap_err();
                assert_eq!(err.code, REPLICATION_TIMEOUT);
                assert!(err.message.contains("detached"), "{err}");
            }
        });
        assert_eq!(p.primary.replica_waiters(), 0);
        let next = write(&p.primary, "test.k2", "v2");
        assert!(!p.primary.wait_replicated(next).unwrap().required);
        assert!(
            !p.primary.detach_replica("f1", "again").unwrap(),
            "a second detach commits nothing"
        );
        // The detach replicates: the follower holds the note and no attach key.
        catch_up(&p.follower, &p.primary);
        let read = f1_keys(&p.follower);
        assert!(read.0.is_none());
        let note: ReplicaDetach = serde_json::from_slice(&read.1.unwrap()).unwrap();
        assert_eq!(
            (note.generation, note.reason.as_str()),
            (1, "operator: follower retired")
        );
        // A new attach gets the next generation; an ack of the old one is refused.
        let again = p.primary.attach_replica("f1").unwrap();
        assert_eq!(again.generation, 2);
        let cursor = p.primary.last_commit_position().unwrap();
        let err = p
            .primary
            .report_replica_ack("f1", 1, cursor, None)
            .unwrap_err();
        assert_eq!(err.code, INVALID_STATE);
    }
}

/// The follower's view of f1's keys (attach, detach note).
fn f1_keys(follower: &Follower) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    use gbrain_store::kv::Kv;
    let read = follower.records().snapshot().unwrap();
    (
        read.get(&replica_key("f1")).unwrap(),
        read.get(&replica_detach_key("f1")).unwrap(),
    )
}

/// Fail-first #10 (F8): acks that cannot be true are refused and change nothing.
#[test]
fn acks_that_cannot_be_true_are_refused() {
    for concurrent in MODES {
        let p = pair("ra-refuse", concurrent);
        let at = write(&p.primary, "test.k", "v");
        let newest = at;
        let future = CommitPosition::new(newest.sequence + 1, 0);
        let other = vec![Timeline {
            id: "00000000-0000-7000-8000-00000000000f".into(),
            from: CommitPosition::new(1, 0),
        }];
        for (id, generation, cursor, lineage, why) in [
            ("f1", p.generation, future, None, "a future cursor"),
            ("f1", p.generation + 1, newest, None, "another generation"),
            ("f9", 1, newest, None, "an id that is not attached"),
            (
                "f1",
                p.generation,
                newest,
                Some(other.as_slice()),
                "another history",
            ),
        ] {
            let err = p
                .primary
                .report_replica_ack(id, generation, cursor, lineage)
                .unwrap_err();
            assert_eq!(err.code, INVALID_STATE, "{why}: {err}");
            assert!(!p.primary.replica_cover(at).unwrap().covered, "{why}");
        }
        // An older cursor never moves the ack back.
        p.primary
            .report_replica_ack("f1", p.generation, newest, Some(&[]))
            .unwrap();
        let back = p
            .primary
            .report_replica_ack("f1", p.generation, CommitPosition::new(1, 0), None)
            .unwrap();
        assert_eq!(back, newest);
        assert!(p.primary.replica_cover(at).unwrap().covered);
        for bad in ["", "a/b", &"x".repeat(129)] {
            assert_eq!(
                p.primary.attach_replica(bad).unwrap_err().code,
                INVALID_ARGUMENT,
                "{bad:?}"
            );
        }
    }
}

/// F6: a restarted primary keeps the attached set (it is in the records) and waits again until the follower
/// reports its cursor once more.
#[test]
fn a_restarted_primary_keeps_waiting_until_the_follower_reports_again() {
    for concurrent in MODES {
        let p = pair("ra-restart", concurrent);
        let at = write(&p.primary, "test.k", "v");
        catch_up(&p.follower, &p.primary);
        p.primary
            .report_replica_ack("f1", p.generation, p.follower.cursor().unwrap(), None)
            .unwrap();
        assert!(p.primary.replica_cover(at).unwrap().covered);
        let Pair {
            _dir,
            root,
            primary,
            follower,
            generation,
        } = p;
        drop(primary);
        let primary = Store::open_dir(&root.join("primary"), mu(concurrent)).unwrap();
        let cover = primary.replica_cover(at).unwrap();
        assert!(cover.required && !cover.covered && cover.acked_through.is_none());
        primary
            .report_replica_ack(
                "f1",
                generation,
                follower.cursor().unwrap(),
                Some(&follower.lineage()),
            )
            .unwrap();
        assert!(primary.replica_cover(at).unwrap().covered);
    }
}

/// F7: a full wait budget refuses at once, before any wait starts.
#[test]
fn a_full_wait_budget_refuses_at_once() {
    let p = pair("ra-budget", true);
    p.primary.set_replica_ack_settings(settings(600_000, 2));
    let at = write(&p.primary, "test.k", "v");
    std::thread::scope(|s| {
        let waits: Vec<_> = (0..2)
            .map(|_| s.spawn(|| p.primary.wait_replicated(at)))
            .collect();
        until("2 waiters", || p.primary.replica_waiters() == 2);
        let started = Instant::now();
        let err = p.primary.wait_replicated(at).unwrap_err();
        assert_eq!(err.code, REPLICATION_TIMEOUT);
        assert!(err.message.contains("budget"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(p.primary.replica_waiters(), 2);
        catch_up(&p.follower, &p.primary);
        p.primary
            .report_replica_ack("f1", p.generation, p.follower.cursor().unwrap(), None)
            .unwrap();
        for w in waits {
            assert!(w.join().unwrap().unwrap().covered);
        }
    });
}

/// #6: with the switch off nothing is required, attach is refused, and no replica key is ever written.
#[test]
fn with_multi_user_mode_off_replica_acks_do_nothing() {
    let dir = TempDir::new("ra-off");
    let store = Store::open_dir(&dir.path().join("brain"), OpenOptions::default()).unwrap();
    store.set_config("test.k", "v").unwrap();
    assert_eq!(store.attach_replica("f1").unwrap_err().code, INVALID_STATE);
    assert_eq!(
        store.detach_replica("f1", "x").unwrap_err().code,
        INVALID_STATE
    );
    let cover = store.replica_cover(CommitPosition::new(1, 0)).unwrap();
    assert!(!cover.required);
    assert!(store.attached_replicas().unwrap().is_empty());
    assert_eq!(store.replica_ack_settings(), ReplicaAckSettings::default());
    let snap = dir.path().join("snap");
    store.snapshot_to(&snap, &SnapshotOp::new()).unwrap();
    let kv = gbrain_store::redb_kv::RedbReadOnlyKv::open_path(&snap.join("records.redb")).unwrap();
    use gbrain_store::kv::Kv;
    let read = kv.snapshot().unwrap();
    let mut seen = 0;
    read.scan(&[1], &[0xFF; 64], false, &mut |k, _| {
        assert!(!is_replica_key(k), "{}", k.escape_ascii());
        seen += 1;
        true
    })
    .unwrap();
    assert!(seen > 0);
}

/// C1 (Ember's add): a write that waits while its replica promotes ends `replication_timeout`, never success; it
/// stays durable on the old primary, and the old primary's diverged-tail export keeps it.
#[test]
fn a_write_waiting_while_the_replica_promotes_ends_timeout_and_the_export_keeps_it() {
    for concurrent in MODES {
        let p = pair("ra-c1", concurrent);
        p.primary.set_replica_ack_settings(settings(200, 8));
        let pending = write(&p.primary, "test.pending", "outcome unknown");
        let Pair {
            _dir,
            root,
            primary,
            follower,
            ..
        } = p;
        let promoted = std::thread::scope(|s| {
            let wait = s.spawn(|| primary.wait_replicated(pending));
            until("the waiter", || primary.replica_waiters() == 1);
            let promoted = promote(follower, concurrent);
            let err = wait.join().unwrap().unwrap_err();
            assert_eq!(err.code, REPLICATION_TIMEOUT, "never ok: {err}");
            promoted
        });
        write(&promoted, "test.new", "x");
        assert_eq!(
            primary.get_config("test.pending").unwrap().as_deref(),
            Some("outcome unknown")
        );
        // The old primary stops and becomes a follower of the promoted one: its tail is refused until exported.
        drop(primary);
        let old = Follower::open(&root.join("primary")).unwrap();
        let page = promoted.read_commit_log(None, usize::MAX).unwrap();
        let theirs = page.lineage.clone();
        let raw: Vec<_> = page
            .records
            .iter()
            .map(|r| {
                (
                    r.position,
                    gbrain_store::commit_log::encode_commit_record(r),
                )
            })
            .collect();
        assert_eq!(
            old.apply_raw(&page.brain_id, &theirs, &raw)
                .unwrap_err()
                .code,
            DIVERGED_TAIL
        );
        let out = root.join("old-tail");
        let header = old.export_diverged_tail(&out, &theirs).unwrap();
        assert_eq!(header.cursor, pending);
        let tail = gbrain_store::diverged_tail::read_diverged_tail(&out).unwrap();
        assert_eq!(tail.records.last().unwrap().0, pending);
        let kept = gbrain_store::commit_log::decode_record(
            &gbrain_store::commit_log::record_key(pending),
            &tail.records.last().unwrap().1,
        )
        .unwrap();
        assert!(
            kept.ops.iter().any(|(_, op)| matches!(op, LogOp::Put(v) if v.windows(15).any(|w| w == b"outcome unknown"))),
            "the export keeps the pending write"
        );
        old.allow_install_over(&out).unwrap();
        promoted
            .snapshot_to(&root.join("snap-new"), &SnapshotOp::new())
            .unwrap();
        old.install_snapshot(&root.join("snap-new"), None).unwrap();
        assert_eq!(old.lineage(), theirs);
    }
}

/// B1: the mark survives a restart, counts only on the timeline it was heard on, and never leaves the follower
/// directory.
#[test]
fn the_replica_mark_is_durable_and_kept_per_timeline() {
    let p = pair("ra-mark", false);
    let at = write(&p.primary, "test.k", "v");
    catch_up(&p.follower, &p.primary);
    assert!(p.follower.note_primary_acked(at).unwrap());
    assert!(
        !p.follower
            .note_primary_acked(CommitPosition::new(1, 0))
            .unwrap(),
        "never back"
    );
    assert_eq!(p.follower.primary_acked(), Some(at));
    let Pair {
        _dir,
        root,
        primary,
        follower,
        ..
    } = p;
    drop(follower);
    let follower = Follower::open(&root.join("follower")).unwrap();
    assert_eq!(follower.primary_acked(), Some(at));
    assert!(root.join("follower").join("REPLICA-MARK").exists());
    primary
        .snapshot_to(&root.join("snap2"), &SnapshotOp::new())
        .unwrap();
    assert!(!root.join("snap2").join("REPLICA-MARK").exists());
    drop(primary);
    // After the promotion the follower is on a new timeline: the old mark no longer counts.
    let promoted = promote(follower, false);
    let (note, _) = note_of(&promoted);
    assert_eq!(note.acked_seen, Some(at));
    drop(promoted);
    let again = Follower::open(&root.join("follower")).unwrap();
    assert_eq!(again.primary_acked(), None);
}

/// B1: a note without `acked_seen` decodes, and a note with it decodes into a reader that does not know it.
#[test]
fn promotion_notes_decode_with_and_without_acked_seen() {
    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct OldNote {
        timeline: String,
        from: CommitPosition,
        host_id: String,
        basis: String,
        #[serde(default)]
        attested: Option<String>,
        #[serde(default)]
        lease_epoch: Option<u64>,
        promoted_at_us: i64,
    }
    let without = r#"{"timeline":"t","from":{"sequence":3,"index":0},"host_id":"h","basis":"handover","promoted_at_us":5}"#;
    let note: PromotionNote = serde_json::from_str(without).unwrap();
    assert_eq!(note.acked_seen, None);
    assert_eq!(
        serde_json::to_string(&note).unwrap(),
        without,
        "no new field when unset"
    );
    let with = PromotionNote {
        acked_seen: Some(CommitPosition::new(3, 0)),
        ..note
    };
    let text = serde_json::to_string(&with).unwrap();
    assert!(text.contains("acked_seen"));
    let old: OldNote = serde_json::from_str(&text).unwrap();
    assert_eq!(old.timeline, "t");
}
