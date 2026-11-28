//! Taking over as primary (lane L5, `takeover.rs`; lane L2, the promotion fence in `follower.rs` and the primary's write
//! fence in `primary.rs`): the old primary is fenced before the follower promotes, a lapse alone never promotes, the
//! old primary's writes are refused once its lease lapsed or was handed over, and a follower on another history is not
//! continued. Both store modes; the write-fence cases run on explicit single-writer and optimistic record adapters.

mod common;

use common::TempDir;
use gbrain_store::commit_log::{CommitPosition, LogOp};
use gbrain_store::follower::{
    Follower, OldPrimaryStopped, PRIMARY_LIVE, PRIMARY_UNCONFIRMED, PromotionNote,
    SNAPSHOT_REQUIRED, promotion_key,
};
use gbrain_store::kv::Kv;
use gbrain_store::leases::{lost_reason, read_lease_record};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::primary::PRIMARY_NOT_SERVED;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::snapshot::SnapshotOp;
use gbrain_store::takeover::{
    DEFAULT_TAKEOVER_MARGIN_MS, PRIMARY_LEASE, TakeoverSettings, continue_following, take_over,
    take_over_with,
};
use gbrain_store::transactions::{TxnMode, TxnOptions};
use gbrain_store::write_origin::WriteOrigin;
use gbrain_store::{Env, MultiUserWrites, OpenOptions, Store, StoreError, SystemEnv};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
const MODES: [bool; 2] = [false, true];

fn mu(concurrent: bool) -> OpenOptions {
    OpenOptions {
        concurrent_writes: concurrent,
        keyword_index_builder: false,
        multiuser: true,
        multiuser_writes: MultiUserWrites {
            commit_log: true,
            host_id: Some(HOST.into()),
            ..Default::default()
        },
        ..OpenOptions::default()
    }
}

fn origin(who: &str) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("{who}-host"),
        incarnation: format!("{who}-run"),
        writer_id: "local_cli:test".into(),
    }
}

/// One machine's clock, set by hand; it starts at the wall clock so it is above every durable commit time.
struct HandClock(AtomicI64);

impl HandClock {
    fn new() -> Arc<HandClock> {
        Arc::new(HandClock(AtomicI64::new(SystemEnv.now_micros())))
    }
    fn set(&self, at: i64) {
        self.0.store(at, Ordering::SeqCst);
    }
}

impl Env for HandClock {
    fn now_micros(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        SystemEnv.new_uuid()
    }
}

fn catch_up(follower: &Follower, primary: &Store) {
    loop {
        let page = primary.read_commit_log(follower.cursor(), 50).unwrap();
        if page.records.is_empty() {
            return;
        }
        continue_following(follower, &page).unwrap();
    }
}

fn follower_of(primary: &Store, root: &Path, name: &str) -> Follower {
    let snap = root.join(format!("snap-{name}"));
    let manifest = primary.snapshot_to(&snap, &SnapshotOp::new()).unwrap();
    let f = Follower::open(&root.join(name)).unwrap();
    f.install_snapshot(&snap, Some(&manifest)).unwrap();
    f
}

/// Every key, the sequence and the lineage of a follower: what a refused promotion must leave as it was.
fn state_of(
    f: &Follower,
) -> (
    Vec<(Vec<u8>, Vec<u8>)>,
    u64,
    Vec<gbrain_store::commit_log::Timeline>,
) {
    let read = f.records().snapshot().unwrap();
    let mut keys = Vec::new();
    read.scan(&[1], &[0xFF; 64], false, &mut |k, v| {
        keys.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    (keys, f.sequence().unwrap(), f.lineage())
}

fn code_of(e: &StoreError) -> &str {
    e.message.split(':').next().unwrap_or("")
}

fn attest() -> OldPrimaryStopped {
    OldPrimaryStopped::attest("operator: the old primary's machine is powered off").unwrap()
}

/// A primary that serves under the primary lease (`ttl_ms`) on `clock`, with a follower caught up to it.
struct Served {
    _dir: TempDir,
    root: std::path::PathBuf,
    clock: Arc<HandClock>,
    primary: Store,
    expires_at_us: i64,
    epoch: u64,
}

fn served(name: &str, concurrent: bool, ttl_ms: u64) -> (Served, Follower) {
    let dir = TempDir::new(name);
    let root = dir.path().to_path_buf();
    let clock = HandClock::new();
    let primary =
        Store::open_dir_with_env(&root.join("primary"), mu(concurrent), clock.clone()).unwrap();
    let token = primary
        .serve_as_primary(&origin("old"), ttl_ms)
        .unwrap()
        .expect("nobody holds the primary lease yet");
    primary.set_config("before", "1").unwrap();
    let follower = follower_of(&primary, &root, "follower");
    primary.set_config("after-snapshot", "1").unwrap();
    catch_up(&follower, &primary);
    let rec = read_lease_record(&*follower.records().snapshot().unwrap(), PRIMARY_LEASE)
        .unwrap()
        .expect("the primary lease is replicated with the data");
    assert_eq!(rec.epoch, token.epoch);
    (
        Served {
            _dir: dir,
            root,
            clock,
            primary,
            expires_at_us: rec.expires_at_us,
            epoch: rec.epoch,
        },
        follower,
    )
}

fn promote_at(
    s: &Served,
    follower: Follower,
    concurrent: bool,
    margin_ms: u64,
    stopped: Option<&OldPrimaryStopped>,
) -> gbrain_store::Result<Store> {
    follower.promote_with(
        mu(concurrent),
        s.clock.clone(),
        &TakeoverSettings { margin_ms },
        stopped,
    )
}

/// The promotion note of the brain's newest timeline, from its first commit (the log carries it to followers).
fn note_of(store: &Store) -> PromotionNote {
    let page = store.read_commit_log(None, usize::MAX).unwrap();
    let id = &page
        .lineage
        .last()
        .expect("a promoted brain has a timeline")
        .id;
    let key = promotion_key(id);
    let record = page
        .records
        .iter()
        .find(|r| r.ops.iter().any(|(k, _)| *k == key))
        .expect("the promotion note is a commit of the new timeline");
    assert_eq!(record.origin.writer_id, "promotion");
    let Some((_, LogOp::Put(value))) = record.ops.iter().find(|(k, _)| *k == key) else {
        panic!("the promotion note is not a put");
    };
    serde_json::from_slice(value).unwrap()
}

// --- The promotion fence (lane L2, ruling A) ---------------------------------------------------------------------------

/// Fail-first: on 016947c166 `Follower::promote` promoted while the old primary's replicated lease was live.
#[test]
fn a_promotion_while_the_old_primary_lease_is_live_is_refused_and_changes_nothing() {
    for concurrent in MODES {
        let (s, follower) = served("fence-live", concurrent, 60_000);
        let before = state_of(&follower);
        let dir = s.root.join("follower");
        let e = follower
            .promote(mu(concurrent))
            .err()
            .expect("promoted under a live lease");
        assert_eq!(code_of(&e), PRIMARY_LIVE, "{concurrent}: {e}");
        let follower = Follower::open(&dir).unwrap();
        assert_eq!(
            state_of(&follower),
            before,
            "{concurrent}: the refused promotion changed the follower"
        );
        // An attestation does not override a live lease.
        let stopped = attest();
        let e = promote_at(&s, follower, concurrent, 0, Some(&stopped))
            .err()
            .unwrap();
        assert_eq!(code_of(&e), PRIMARY_LIVE, "{concurrent}: {e}");
        assert_eq!(state_of(&Follower::open(&dir).unwrap()), before);
    }
}

/// Ruling A (a): a lapse without an attestation is refused `primary_unconfirmed`, also long after the margin.
#[test]
fn a_lapse_without_an_attestation_is_refused_primary_unconfirmed() {
    for concurrent in MODES {
        let (s, follower) = served("fence-unconfirmed", concurrent, 5_000);
        let before = state_of(&follower);
        s.clock.set(s.expires_at_us + 3_600_000_000);
        let e = promote_at(&s, follower, concurrent, 0, None).err().unwrap();
        assert_eq!(code_of(&e), PRIMARY_UNCONFIRMED, "{concurrent}: {e}");
        assert_eq!(
            state_of(&Follower::open(&s.root.join("follower")).unwrap()),
            before
        );
    }
}

/// Ruling A (b) and (c): an attested promotion waits for the lease's end plus the margin on this machine's clock; then
/// it promotes and the new timeline's promotion note records the reason. Margin 0 and the default margin.
#[test]
fn an_attested_promotion_waits_for_the_lease_end_plus_the_margin_and_records_the_reason() {
    assert_eq!(
        TakeoverSettings::default().margin_ms,
        DEFAULT_TAKEOVER_MARGIN_MS
    );
    assert_eq!(DEFAULT_TAKEOVER_MARGIN_MS, 2_000);
    for concurrent in MODES {
        // The default margin: refused 1 s after the lease's end, promotes 2 s after it.
        let (s, follower) = served("fence-margin", concurrent, 5_000);
        let before = state_of(&follower);
        let dir = s.root.join("follower");
        let stopped = attest();
        s.clock.set(s.expires_at_us + 1_000_000);
        let e = promote_at(
            &s,
            follower,
            concurrent,
            DEFAULT_TAKEOVER_MARGIN_MS,
            Some(&stopped),
        )
        .err()
        .unwrap();
        assert_eq!(code_of(&e), PRIMARY_LIVE, "{concurrent}: {e}");
        let follower = Follower::open(&dir).unwrap();
        assert_eq!(state_of(&follower), before);
        let cursor = follower.cursor().unwrap();
        s.clock.set(s.expires_at_us + 2_000_000);
        let promoted = promote_at(
            &s,
            follower,
            concurrent,
            DEFAULT_TAKEOVER_MARGIN_MS,
            Some(&stopped),
        )
        .unwrap();
        let note = note_of(&promoted);
        assert_eq!(note.basis, "attested");
        assert_eq!(note.attested.as_deref(), Some(stopped.reason()));
        assert_eq!(note.lease_epoch, Some(s.epoch));
        assert_eq!(note.from, cursor);
        assert_eq!(note.host_id, HOST);
        // The note is the new timeline's first commit: it replicates with the log.
        let page = promoted.read_commit_log(Some(cursor), 10).unwrap();
        assert_eq!(
            page.records[0].position,
            CommitPosition::new(cursor.sequence + 1, 0)
        );
        assert_eq!(page.lineage.last().unwrap().from, cursor);

        // Margin 0: promotes at the lease's end.
        let (s, follower) = served("fence-margin-0", concurrent, 5_000);
        s.clock.set(s.expires_at_us - 1);
        let e = promote_at(&s, follower, concurrent, 0, Some(&stopped))
            .err()
            .unwrap();
        assert_eq!(code_of(&e), PRIMARY_LIVE, "{concurrent}: {e}");
        let follower = Follower::open(&s.root.join("follower")).unwrap();
        s.clock.set(s.expires_at_us);
        let promoted = promote_at(&s, follower, concurrent, 0, Some(&stopped)).unwrap();
        assert_eq!(note_of(&promoted).basis, "attested");
    }
}

/// Ruling A (d): a clean hand-over (the old primary released its lease, and the follower applied the release) promotes
/// at once, with no attestation and no wait, while the old lease's end is still ahead.
#[test]
fn a_clean_handover_promotes_at_once() {
    for concurrent in MODES {
        let (s, follower) = served("fence-handover", concurrent, 60_000);
        s.primary.release_primary().unwrap();
        catch_up(&follower, &s.primary);
        assert!(s.clock.now_micros() < s.expires_at_us);
        let promoted =
            promote_at(&s, follower, concurrent, DEFAULT_TAKEOVER_MARGIN_MS, None).unwrap();
        let note = note_of(&promoted);
        assert_eq!(note.basis, "handover");
        assert_eq!(note.attested, None);
        // The promoted store holds a replicated primary lease: it serves before it writes.
        let e = promoted.set_config("x", "1").unwrap_err();
        assert_eq!(
            lost_reason(&e).as_deref(),
            Some(PRIMARY_NOT_SERVED),
            "{concurrent}: {e}"
        );
        let token = promoted
            .serve_as_primary(&origin("new"), 60_000)
            .unwrap()
            .unwrap();
        assert_eq!(token.epoch, s.epoch + 1);
        promoted.set_config("x", "1").unwrap();
    }
}

/// A takeover on the old primary's lapsed lease, with the attestation: the new primary serves at the next epoch, a
/// write with the old token is refused there (`epoch_moved`), and the old primary's own writes are refused at its
/// commit (`expired`) and change nothing.
#[test]
fn the_old_primary_is_fenced_before_the_follower_promotes_and_its_writes_are_refused_after() {
    for concurrent in MODES {
        let (s, follower) = served("takeover-fence", concurrent, 6_000);
        let old = s.primary.primary_token().unwrap();
        // Too early: the old primary's lease is still live; nothing is promoted (no new timeline).
        let lineage_before = follower.lineage();
        let stopped = attest();
        let early = take_over_with(
            follower,
            &origin("new"),
            mu(concurrent),
            60_000,
            s.clock.clone(),
            &TakeoverSettings::default(),
            Some(&stopped),
        )
        .err()
        .expect("promoted while the old lease was live");
        assert!(
            early.message.starts_with("primary_live"),
            "{concurrent}: {early}"
        );
        let follower = Follower::open(&s.root.join("follower")).unwrap();
        assert!(
            follower.cursor().is_some(),
            "{concurrent}: the follower is still a follower"
        );
        assert_eq!(
            follower.lineage(),
            lineage_before,
            "{concurrent}: the refused takeover promoted the follower"
        );

        s.clock.set(s.expires_at_us + 2_000_000);
        let (promoted, token) = take_over_with(
            follower,
            &origin("new"),
            mu(concurrent),
            60_000,
            s.clock.clone(),
            &TakeoverSettings::default(),
            Some(&stopped),
        )
        .unwrap();
        assert_eq!(token.epoch, old.epoch + 1, "{concurrent}");

        // The old primary writes after the takeover: refused at its own commit, nothing written ...
        let before = s.primary.get_config("late").unwrap();
        let e = s.primary.set_config("late", "1").unwrap_err();
        assert_eq!(
            lost_reason(&e).as_deref(),
            Some("expired"),
            "{concurrent}: {e}"
        );
        assert_eq!(s.primary.get_config("late").unwrap(), before);
        let e = s
            .primary
            .check_fence_now(Some(&old), "old primary write")
            .unwrap_err();
        assert_eq!(lost_reason(&e).as_deref(), Some("expired"), "{concurrent}");
        // ... and a write that carries its token is refused on the new primary (the epoch moved).
        let e = promoted
            .check_fence_now(Some(&old), "old primary write")
            .unwrap_err();
        assert_eq!(
            lost_reason(&e).as_deref(),
            Some("epoch_moved"),
            "{concurrent}"
        );
        promoted
            .check_fence_now(Some(&token), "new primary write")
            .unwrap();
        promoted.set_config("after", "1").unwrap();
    }
}

#[test]
fn a_follower_on_another_lineage_is_not_continued() {
    for concurrent in MODES {
        let dir = TempDir::new("takeover-lineage");
        let root = dir.path().to_path_buf();
        let primary = Store::open_dir(&root.join("primary"), mu(concurrent)).unwrap();
        primary.set_config("seed", "1").unwrap();
        let a = follower_of(&primary, &root, "a");
        let b = follower_of(&primary, &root, "b");
        for n in 0..6 {
            primary.set_config(&format!("k{n}"), "v").unwrap();
        }
        catch_up(&a, &primary);
        catch_up(&b, &primary);
        // B also applies a commit A never saw, then A is promoted at its older cursor: B is ahead on the old history.
        primary.set_config("only-b", "1").unwrap();
        catch_up(&b, &primary);
        drop(primary);
        let stopped = OldPrimaryStopped::attest("test: the primary was dropped").unwrap();
        let (new_primary, _) = take_over_with(
            a,
            &origin("a"),
            mu(concurrent),
            60_000,
            Arc::new(SystemEnv),
            &TakeoverSettings::default(),
            Some(&stopped),
        )
        .unwrap();
        new_primary.set_config("after-promotion", "1").unwrap();
        let before = b.cursor();
        let page = new_primary.read_commit_log(b.cursor(), 50).unwrap();
        let e = continue_following(&b, &page).unwrap_err();
        assert_eq!(e.code, SNAPSHOT_REQUIRED, "{concurrent}: {e}");
        assert_eq!(b.cursor(), before, "{concurrent}: nothing applied");
    }
}

/// Pinned (expected to pass on 016947c166 too): a stale primary's log cannot be followed on the new timeline, and a
/// follower of the old primary that applied a commit the new timeline lost is told to install a snapshot.
#[test]
fn a_stale_primary_is_not_followed_on_the_new_timeline() {
    for concurrent in MODES {
        let (s, follower) = served("stale-primary", concurrent, 5_000);
        let old_follower = follower_of(&s.primary, &s.root, "old-follower");
        // A commit the promoted follower never applies: the new timeline loses it (an open case of the READY).
        s.primary.set_config("only-old", "1").unwrap();
        catch_up(&old_follower, &s.primary);
        let cursor = follower.cursor();
        s.clock.set(s.expires_at_us + 2_000_000);
        let stopped = attest();
        let (promoted, _) = take_over_with(
            follower,
            &origin("new"),
            mu(concurrent),
            60_000,
            s.clock.clone(),
            &TakeoverSettings::default(),
            Some(&stopped),
        )
        .unwrap();
        promoted.set_config("new-timeline", "1").unwrap();
        assert_eq!(promoted.get_config("only-old").unwrap(), None);
        // A follower of the new timeline is offered the stale primary's log: refused, nothing applied.
        let new_follower = follower_of(&promoted, &s.root, "new-follower");
        let at = new_follower.cursor();
        let stale = s.primary.read_commit_log(cursor, 50).unwrap();
        assert!(!stale.records.is_empty());
        let e = continue_following(&new_follower, &stale).unwrap_err();
        assert_eq!(e.code, SNAPSHOT_REQUIRED, "{concurrent}: {e}");
        assert_eq!(new_follower.cursor(), at);
        // The old primary's follower holds the lost commit: told to install a snapshot, nothing applied.
        let before = old_follower.cursor();
        let page = promoted.read_commit_log(old_follower.cursor(), 50).unwrap();
        if !page.snapshot_required {
            let e = continue_following(&old_follower, &page).unwrap_err();
            assert_eq!(e.code, SNAPSHOT_REQUIRED, "{concurrent}: {e}");
        }
        assert_eq!(old_follower.cursor(), before);
    }
}

/// Invalid takeover inputs are refused before the follower changes.
#[test]
fn invalid_takeover_inputs_leave_the_follower_unchanged() {
    for concurrent in MODES {
        let (s, follower) = served("takeover-inputs", concurrent, 5_000);
        let dir = s.root.join("follower");
        let before = state_of(&follower);
        s.clock.set(s.expires_at_us + 10_000_000);
        let stopped = attest();
        let mut follower = follower;
        for (holder, ttl, margin) in [
            (origin("new"), 0, 0),
            (
                WriteOrigin {
                    host_id: String::new(),
                    ..origin("new")
                },
                60_000,
                0,
            ),
            (origin("new"), 60_000, u64::MAX),
        ] {
            let e = take_over_with(
                follower,
                &holder,
                mu(concurrent),
                ttl,
                s.clock.clone(),
                &TakeoverSettings { margin_ms: margin },
                Some(&stopped),
            )
            .err()
            .unwrap();
            assert_eq!(e.code, "invalid_argument", "{concurrent}: {e}");
            follower = Follower::open(&dir).unwrap();
            assert_eq!(
                state_of(&follower),
                before,
                "{concurrent}: a refused takeover changed the follower"
            );
        }
        assert!(OldPrimaryStopped::attest("  ").is_err());
        assert!(OldPrimaryStopped::attest(&"x".repeat(513)).is_err());
    }
}

/// Recovery after the durable half of a promotion (`Follower::start_timeline`) when the open did not follow (a crash,
/// or a `promotion_partial` error): the directory opens as the promoted brain and serves; a second promotion of the
/// directory instead starts one more timeline and loses nothing.
#[test]
fn a_promotion_cut_after_its_timeline_recovers_by_opening_the_brain() {
    for concurrent in MODES {
        let (s, follower) = served("promotion-partial", concurrent, 5_000);
        s.clock.set(s.expires_at_us + 2_000_000);
        let stopped = attest();
        let id = follower
            .start_timeline(&*s.clock, 2_000_000, HOST, Some(&stopped))
            .unwrap();
        drop(follower);
        // Recipe 1: open the brain and serve as primary.
        let store =
            Store::open_dir_with_env(&s.root.join("follower"), mu(concurrent), s.clock.clone())
                .unwrap();
        assert_eq!(
            store
                .read_commit_log(None, 1)
                .unwrap()
                .lineage
                .last()
                .unwrap()
                .id,
            id
        );
        assert_eq!(
            lost_reason(&store.set_config("x", "1").unwrap_err()).as_deref(),
            Some(PRIMARY_NOT_SERVED)
        );
        store
            .serve_as_primary(&origin("new"), 60_000)
            .unwrap()
            .unwrap();
        store.set_config("x", "1").unwrap();
        drop(store);
        // Recipe 2 (a retry): a second promotion of the same directory adds one more timeline; the data stays.
        let (s2, follower) = served("promotion-retry", concurrent, 5_000);
        s2.clock.set(s2.expires_at_us + 2_000_000);
        let first = follower
            .start_timeline(&*s2.clock, 2_000_000, HOST, Some(&stopped))
            .unwrap();
        drop(follower);
        let follower = Follower::open(&s2.root.join("follower")).unwrap();
        let promoted = promote_at(
            &s2,
            follower,
            concurrent,
            DEFAULT_TAKEOVER_MARGIN_MS,
            Some(&stopped),
        )
        .unwrap();
        let lineage = promoted.read_commit_log(None, 1).unwrap().lineage;
        assert_eq!(lineage.len(), 2);
        assert_eq!(lineage[0].id, first);
        assert_eq!(promoted.get_config("before").unwrap().as_deref(), Some("1"));
    }
}

// --- The primary's write fence (`primary.rs`) -------------------------------------------------------------------------

/// A store on an explicit record adapter (single-writer `RedbKv` or optimistic `OccKv`), on `clock`.
fn adapter_store(path: &Path, optimistic: bool, clock: &Arc<HandClock>) -> Store {
    let base = RedbKv::open_path(&path.join("records.redb")).unwrap();
    let kv: Arc<dyn Kv> = if optimistic {
        Arc::new(OccKv::new(base).unwrap())
    } else {
        Arc::new(base)
    };
    let store = Store::open_kv(kv, clock.clone(), mu(optimistic)).unwrap();
    assert_eq!(
        store.occ_stats().is_some(),
        optimistic,
        "the adapter is not the one asked for"
    );
    assert!(store.multiuser() && store.info().commit_log);
    store
}

fn sequence_of(store: &Store) -> u64 {
    store
        .read_commit_log(None, 0)
        .unwrap()
        .newest
        .map_or(0, |p| p.sequence)
}

/// Fail-first: on 016947c166 a primary whose lease lapsed went on committing. Every write kind is refused once the
/// lease's end passed, and nothing is written.
#[test]
fn a_primary_whose_lease_lapsed_refuses_every_write_kind() {
    for optimistic in MODES {
        let dir = TempDir::new("primary-lapse");
        let clock = HandClock::new();
        let store = adapter_store(dir.path(), optimistic, &clock);
        store
            .serve_as_primary(&origin("p"), 5_000)
            .unwrap()
            .unwrap();
        store.set_config("inside", "1").unwrap();
        clock.set(clock.now_micros() + 5_000_001);
        let before = sequence_of(&store);
        let e = store.set_config("late", "1").unwrap_err();
        assert_eq!(
            lost_reason(&e).as_deref(),
            Some("expired"),
            "{optimistic}: {e}"
        );
        // A serialized explicit transaction.
        let refused = store
            .begin_transaction(false)
            .and_then(|tx| {
                tx.set_config("late-tx", "1")?;
                tx.commit_transaction()
            })
            .unwrap_err();
        assert_eq!(
            lost_reason(&refused).as_deref(),
            Some("expired"),
            "{optimistic}: {refused}"
        );
        // An optimistic transaction (the optimistic adapter only: the single-writer store refuses the mode).
        if optimistic {
            let refused = store
                .begin_with(TxnOptions {
                    mode: TxnMode::Optimistic,
                    ..TxnOptions::default()
                })
                .and_then(|tx| {
                    tx.store().set_config("late-opt", "1")?;
                    tx.commit()
                })
                .unwrap_err();
            assert_eq!(
                lost_reason(&refused).as_deref(),
                Some("expired"),
                "{optimistic}: {refused}"
            );
        }
        assert_eq!(
            sequence_of(&store),
            before,
            "{optimistic}: a refused write committed"
        );
        for key in ["late", "late-tx", "late-opt"] {
            assert_eq!(store.get_config(key).unwrap(), None, "{optimistic}: {key}");
        }
        // A renewal after the lapse is refused too: a lapsed primary never comes back on its own.
        assert!(store.renew_primary(5_000).is_err());
    }
}

/// The commit-accept check: a transaction whose statements passed the lease check while the lease held, but which
/// commits after the lease's end, is refused at the record file (the pipeline's batch write on the optimistic adapter,
/// the single-writer commit on the other), with nothing written. A serialized transaction on both adapters, an
/// optimistic one on the optimistic adapter.
#[test]
fn a_write_that_commits_after_the_lease_end_is_refused_at_commit() {
    for optimistic in MODES {
        let modes: &[TxnMode] = if optimistic {
            &[TxnMode::Serialized, TxnMode::Optimistic]
        } else {
            &[TxnMode::Serialized]
        };
        for mode in modes {
            let dir = TempDir::new("primary-commit-accept");
            let clock = HandClock::new();
            let store = adapter_store(dir.path(), optimistic, &clock);
            store
                .serve_as_primary(&origin("p"), 5_000)
                .unwrap()
                .unwrap();
            let before = sequence_of(&store);
            let tx = store
                .begin_with(TxnOptions {
                    mode: *mode,
                    ..TxnOptions::default()
                })
                .unwrap();
            tx.store().set_config("waited", "1").unwrap();
            clock.set(clock.now_micros() + 5_000_001);
            let e = tx.commit().unwrap_err();
            assert_eq!(
                lost_reason(&e).as_deref(),
                Some("expired"),
                "{optimistic} {mode:?}: {e}"
            );
            assert_eq!(sequence_of(&store), before, "{optimistic} {mode:?}");
            assert_eq!(store.get_config("waited").unwrap(), None);
        }
    }
}

/// Fail-first: on 016947c166 a primary that released its lease went on committing. After `release_primary` every write
/// is refused (`released`); serving again takes the next epoch.
#[test]
fn a_primary_that_handed_over_refuses_writes_until_it_serves_again() {
    for optimistic in MODES {
        let dir = TempDir::new("primary-release");
        let clock = HandClock::new();
        let store = adapter_store(dir.path(), optimistic, &clock);
        let token = store
            .serve_as_primary(&origin("p"), 60_000)
            .unwrap()
            .unwrap();
        store.release_primary().unwrap();
        let e = store.set_config("after-release", "1").unwrap_err();
        assert_eq!(
            lost_reason(&e).as_deref(),
            Some("released"),
            "{optimistic}: {e}"
        );
        assert_eq!(store.get_config("after-release").unwrap(), None);
        let again = store
            .serve_as_primary(&origin("p"), 60_000)
            .unwrap()
            .unwrap();
        assert_eq!(again.epoch, token.epoch + 1);
        store.set_config("after-release", "1").unwrap();
    }
}

/// A store reopened on a brain that holds a primary lease starts fail-closed: writes are refused until it serves as
/// primary, and while the old lease is live it cannot take it. A brain that never held one is never fenced.
#[test]
fn a_reopened_primary_refuses_writes_until_it_serves() {
    for optimistic in MODES {
        let dir = TempDir::new("primary-reopen");
        let clock = HandClock::new();
        let store = adapter_store(dir.path(), optimistic, &clock);
        store
            .serve_as_primary(&origin("p"), 5_000)
            .unwrap()
            .unwrap();
        store.set_config("k", "1").unwrap();
        drop(store);
        let store = adapter_store(dir.path(), optimistic, &clock);
        let e = store.set_config("k", "2").unwrap_err();
        assert_eq!(
            lost_reason(&e).as_deref(),
            Some(PRIMARY_NOT_SERVED),
            "{optimistic}: {e}"
        );
        assert_eq!(
            store.serve_as_primary(&origin("p"), 5_000).unwrap(),
            None,
            "the live lease is not re-taken"
        );
        clock.set(clock.now_micros() + 5_000_001);
        store
            .serve_as_primary(&origin("p"), 5_000)
            .unwrap()
            .unwrap();
        store.set_config("k", "2").unwrap();
        // Never armed: a brain with no primary lease writes as before.
        let plain = TempDir::new("primary-never");
        let store = adapter_store(plain.path(), optimistic, &clock);
        store.set_config("k", "1").unwrap();
        assert_eq!(store.primary_token(), None);
    }
}

// --- Guards ------------------------------------------------------------------------------------------------------------

fn files_under(dir: &Path, ext: &str, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n == "node_modules") {
                continue;
            }
            files_under(&path, ext, out);
        } else if path.extension().is_some_and(|e| e == ext) {
            out.push(path);
        }
    }
}

/// Promotion has no product path (Ember, 5:15 PM PST 2026-11-27): no napi binding, TypeScript caller or CLI command
/// reaches `promote`, `take_over` or the primary fence. The napi `Follower` family (apply, install, cursor, for lane
/// L3's follower frames) stays; it exposes no promotion. Two primaries after a dual promote are M4 (work item 9e3753d4).
#[test]
fn promotion_and_takeover_stay_off_napi_typescript_and_the_cli() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut napi = Vec::new();
    files_under(&crates.join("gbrain-napi/src"), "rs", &mut napi);
    assert!(!napi.is_empty());
    let banned_rust = [
        ".promote(",
        "promote_with",
        "start_timeline",
        "takeover::",
        "take_over(",
        "take_over_with",
        "OldPrimaryStopped",
        "serve_as_primary",
        "renew_primary",
        "release_primary",
    ];
    for file in &napi {
        let text = std::fs::read_to_string(file).unwrap();
        for word in banned_rust {
            assert!(
                !text.contains(word),
                "{} names {word}: promotion has no product path",
                file.display()
            );
        }
    }
    let repo = crates.join("../..");
    let mut ts = Vec::new();
    files_under(&repo.join("src"), "ts", &mut ts);
    assert!(
        ts.len() > 100,
        "the TypeScript sources were not found at {}",
        repo.display()
    );
    let banned_ts = [
        "promoteWith",
        "startTimeline",
        "takeOverWith",
        "serveAsPrimary",
        "renewPrimary",
        "releasePrimary",
        "OldPrimaryStopped",
        "oldPrimaryStopped",
    ];
    for file in &ts {
        let text = std::fs::read_to_string(file).unwrap();
        for word in banned_ts {
            assert!(
                !text.contains(word),
                "{} names {word}: promotion has no product path",
                file.display()
            );
        }
        for line in text.lines() {
            let lower = line.to_lowercase();
            assert!(
                !(lower.contains("follower") && lower.contains(".promote(")),
                "{} promotes a follower: promotion has no product path",
                file.display()
            );
        }
    }
}

/// No automatic path ever builds an `OldPrimaryStopped` (Ember's ruling A, condition 1): outside tests, the only
/// construction is its own definition in follower.rs, it has no `Default`, and nothing calls `attest`.
#[test]
fn nothing_but_a_caller_builds_an_old_primary_stopped_attestation() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut sources = Vec::new();
    for krate in std::fs::read_dir(&crates).unwrap() {
        let src = krate.unwrap().path().join("src");
        if src.is_dir() {
            files_under(&src, "rs", &mut sources);
        }
    }
    let definition = crates
        .join("gbrain-store/src/follower.rs")
        .canonicalize()
        .unwrap();
    for file in &sources {
        let text = std::fs::read_to_string(file).unwrap();
        let is_definition = file.canonicalize().unwrap() == definition;
        let attest_calls = text.matches("OldPrimaryStopped::attest(").count();
        // Struct literals: every `OldPrimaryStopped {` that is not the type's own definition or impl.
        let literals = text.matches("OldPrimaryStopped {").count()
            - text.matches("struct OldPrimaryStopped {").count()
            - text.matches("impl OldPrimaryStopped {").count();
        assert_eq!(attest_calls, 0, "{} attests on its own", file.display());
        if is_definition {
            // The one literal is the one in `attest`.
            assert_eq!(
                literals,
                1,
                "{} builds an OldPrimaryStopped outside attest",
                file.display()
            );
            assert!(!text.contains("impl Default for OldPrimaryStopped"));
            let head = text.split("pub struct OldPrimaryStopped").next().unwrap();
            let derive = head
                .lines()
                .rev()
                .find(|l| l.trim_start().starts_with("#[derive"))
                .unwrap();
            assert!(
                !derive.contains("Default"),
                "OldPrimaryStopped derives Default"
            );
        } else {
            assert_eq!(
                literals,
                0,
                "{} builds an OldPrimaryStopped",
                file.display()
            );
        }
    }
    // The TypeScript side has no way to name one (checked above), and no store default promotes on a lapse.
    let _ = PRIMARY_UNCONFIRMED;
}

/// `take_over` (no attestation) promotes only on a clean hand-over.
#[test]
fn take_over_without_an_attestation_needs_a_clean_handover() {
    for concurrent in MODES {
        let (s, follower) = served("takeover-plain", concurrent, 5_000);
        s.clock.set(s.expires_at_us + 10_000_000);
        let e = take_over(
            follower,
            &origin("new"),
            mu(concurrent),
            60_000,
            s.clock.clone(),
        )
        .err()
        .unwrap();
        assert_eq!(code_of(&e), PRIMARY_UNCONFIRMED, "{concurrent}: {e}");
        let follower = Follower::open(&s.root.join("follower")).unwrap();
        s.primary.serve_as_primary(&origin("old"), 5_000).unwrap();
        // The old primary comes back after the lapse at a new epoch and hands over cleanly.
        s.primary.release_primary().unwrap();
        catch_up(&follower, &s.primary);
        let (_promoted, token) = take_over(
            follower,
            &origin("new"),
            mu(concurrent),
            60_000,
            s.clock.clone(),
        )
        .unwrap();
        assert_eq!(token.epoch, s.epoch + 2);
    }
}
