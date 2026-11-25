//! A follower that copies a commit log brain from its primary's log, snapshot install and
//! promotion (`follower.rs`, rust/docs/store/commit-log.md "Followers and promotion"). Every case
//! runs with the primary on the single-writer and the optimistic store. The ground truth for "the
//! follower equals the primary at position P" is a snapshot of the primary taken at P: every key
//! (the log's included), the commit sequence and the durable commit time.

mod common;

use common::TempDir;
use gbrain_sim::{CrashMode, FaultPlan, SimDisk, SimFile};
use gbrain_store::commit_log::CommitPosition;
use gbrain_store::follower::{Follower, SNAPSHOT_REQUIRED};
use gbrain_store::journal::PageMutation;
use gbrain_store::kv::Kv;
use gbrain_store::redb_kv::{RedbKv, RedbReadOnlyKv, read_commit_time};
use gbrain_store::snapshot::{SnapshotManifest, SnapshotOp};
use gbrain_store::{Env, MultiUserWrites, OpenOptions, Store};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
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
            write_origin: true,
            host_id: Some(HOST.into()),
            log_retention_bytes: None,
        },
        ..OpenOptions::default()
    }
}

/// Every key, the commit sequence and the durable commit time of a record file.
#[derive(Debug, PartialEq, Eq)]
struct Image {
    keys: BTreeMap<Vec<u8>, Vec<u8>>,
    sequence: u64,
    commit_time: Option<i64>,
}

fn image_of(kv: &dyn Kv) -> Image {
    let (read, sequence) = kv.versioned_snapshot().unwrap();
    let mut keys = BTreeMap::new();
    read.scan(&[1], &[0xFF; 64], false, &mut |k, v| {
        keys.insert(k.to_vec(), v.to_vec());
        true
    })
    .unwrap();
    Image {
        keys,
        sequence,
        commit_time: read_commit_time(&*read).unwrap(),
    }
}

/// The primary's state now, through a snapshot of it.
fn primary_image(store: &Store, at: &Path) -> (Image, SnapshotManifest) {
    let _ = std::fs::remove_dir_all(at);
    let manifest = store.snapshot_to(at, &SnapshotOp::new()).unwrap();
    let kv = RedbReadOnlyKv::open_path(&at.join("records.redb")).unwrap();
    (image_of(&kv), manifest)
}

fn mutation(n: u64, slug: &str, body: &str) -> PageMutation {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": "writer-1"},
        "requestId": format!("a0000000-0000-4000-8000-{n:012x}"),
        "slug": slug,
        "page": {"type": "note", "title": slug, "compiled_truth": body},
        "options": {},
    }))
    .unwrap()
}

/// One step of a seeded workload: config puts (some large) and deletes, page mutations, and a
/// rolled-back transaction.
fn step(store: &Store, n: u64) {
    match n % 5 {
        0 => store
            .set_config(
                &format!("test.k{}", n % 3),
                &"v".repeat(1 + (n as usize % 4) * 20_000),
            )
            .unwrap(),
        1 => {
            let _ = store.unset_config(&format!("test.k{}", (n + 1) % 3));
        }
        2 | 3 => {
            store
                .submit_page_mutation(
                    &mutation(n, &format!("notes/p{}", n % 4), &format!("b{n}")),
                    None,
                )
                .unwrap();
        }
        _ => {
            let tx = store.begin_transaction(false).unwrap();
            tx.submit_page_mutation(&mutation(n, "notes/rolled", "x"), None)
                .unwrap();
            tx.rollback_transaction().unwrap();
        }
    }
}

/// Applies every record the primary holds after the follower's cursor.
fn catch_up(follower: &Follower, primary: &Store) -> usize {
    let mut applied = 0;
    loop {
        let page = primary.read_commit_log(follower.cursor(), 5).unwrap();
        if page.records.is_empty() {
            assert!(!page.snapshot_required);
            return applied;
        }
        applied += follower.apply_page(&page).unwrap().applied;
    }
}

struct Pair {
    _dir: TempDir,
    root: PathBuf,
    primary: Store,
}

fn pair(name: &str, concurrent: bool) -> (Pair, Follower) {
    let dir = TempDir::new(name);
    let root = dir.path().to_path_buf();
    let primary = Store::open_dir(&root.join("primary"), mu(concurrent)).unwrap();
    primary.set_config("test.seed", "1").unwrap();
    let follower = Follower::open(&root.join("follower")).unwrap();
    assert_eq!(follower.cursor(), None, "a new follower is empty");
    let (_, manifest) = primary_image(&primary, &root.join("snap"));
    follower
        .install_snapshot(&root.join("snap"), Some(&manifest))
        .unwrap();
    (
        Pair {
            _dir: dir,
            root,
            primary,
        },
        follower,
    )
}

#[test]
fn a_follower_equals_its_primary_at_the_same_position_after_apply_and_after_install() {
    for concurrent in MODES {
        let (p, follower) = pair("follow-equal", concurrent);
        let (image, _) = primary_image(&p.primary, &p.root.join("snap0"));
        assert_eq!(image_of(follower.records()), image, "after the install");
        for n in 0..30 {
            step(&p.primary, n);
            catch_up(&follower, &p.primary);
            let (image, _) = primary_image(&p.primary, &p.root.join("snapn"));
            assert_eq!(
                image_of(follower.records()),
                image,
                "concurrent {concurrent}, step {n}"
            );
        }
        // Reopen the follower: it holds the same position.
        let cursor = follower.cursor();
        drop(follower);
        let follower = Follower::open(&p.root.join("follower")).unwrap();
        assert_eq!(follower.cursor(), cursor);
    }
}

#[test]
fn applying_a_record_twice_is_a_no_op_and_a_gap_changes_nothing() {
    for concurrent in MODES {
        let (p, follower) = pair("follow-twice", concurrent);
        let start = follower.cursor();
        for n in 0..6 {
            step(&p.primary, n);
        }
        let page = p.primary.read_commit_log(start, usize::MAX).unwrap();
        assert!(page.records.len() >= 4);
        let first = follower.apply_page(&page).unwrap();
        assert_eq!(first.applied, page.records.len());
        let after = image_of(follower.records());
        let again = follower.apply_page(&page).unwrap();
        assert_eq!((again.applied, again.skipped), (0, page.records.len()));
        assert_eq!(
            image_of(follower.records()),
            after,
            "a repeat changed the follower"
        );
        // An overlapping page: the old part is skipped, the new part applied.
        step(&p.primary, 10);
        let overlap = p.primary.read_commit_log(start, usize::MAX).unwrap();
        let o = follower.apply_page(&overlap).unwrap();
        assert_eq!(o.skipped, page.records.len());
        assert!(o.applied >= 1);
        // A gap: records that do not start right after the cursor are refused, nothing changes.
        step(&p.primary, 11);
        step(&p.primary, 12);
        let mut gapped = p
            .primary
            .read_commit_log(follower.cursor(), usize::MAX)
            .unwrap();
        assert!(gapped.records.len() >= 2);
        gapped.records.remove(0);
        let before = image_of(follower.records());
        let err = follower.apply_page(&gapped).unwrap_err();
        assert_eq!(err.code, SNAPSHOT_REQUIRED);
        assert_eq!(image_of(follower.records()), before);
    }
}

/// A clock the test sets by hand.
struct HandClock(AtomicI64);

impl Env for HandClock {
    fn now_micros(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        gbrain_store::env::SystemEnv.new_uuid()
    }
}

#[test]
fn promotion_continues_the_positions_and_starts_the_clock_above_the_floor() {
    for concurrent in MODES {
        let dir = TempDir::new("promote");
        let root = dir.path();
        // A primary whose clock runs far ahead of the machine the follower is promoted on.
        let far = 4_000_000_000_000_000;
        std::fs::create_dir_all(root.join("primary")).unwrap();
        let primary = {
            let base = RedbKv::open_path(&root.join("primary/records.redb")).unwrap();
            let kv: Arc<dyn Kv> = if concurrent {
                Arc::new(gbrain_store::occ_kv::OccKv::new(base).unwrap())
            } else {
                Arc::new(base)
            };
            Store::open_kv(kv, Arc::new(HandClock(AtomicI64::new(far))), mu(concurrent)).unwrap()
        };
        for n in 0..8 {
            step(&primary, n);
        }
        // The follower starts from records only (an empty follower takes a snapshot; this primary
        // has no directory, so the follower is seeded through a second, directory-backed primary
        // copy of the same brain: install from a snapshot of that copy).
        drop(primary);
        let copy = Store::open_dir(&root.join("primary"), mu(concurrent)).unwrap();
        let manifest = copy
            .snapshot_to(&root.join("snap"), &SnapshotOp::new())
            .unwrap();
        let follower = Follower::open(&root.join("follower")).unwrap();
        follower
            .install_snapshot(&root.join("snap"), Some(&manifest))
            .unwrap();
        for n in 8..12 {
            step(&copy, n);
        }
        catch_up(&follower, &copy);
        let cursor = follower.cursor().unwrap();
        let floor = follower.last_commit_time().unwrap();
        let last_record = copy
            .read_commit_log(None, usize::MAX)
            .unwrap()
            .records
            .last()
            .unwrap()
            .commit_time;
        assert!(floor >= last_record && floor >= far);
        drop(copy);
        // Promotion on a machine whose clock is far behind.
        let promoted = follower.promote(mu(concurrent)).unwrap();
        promoted.set_config("test.after", "1").unwrap();
        let page = promoted.read_commit_log(Some(cursor), 10).unwrap();
        assert_eq!(page.records.len(), 1);
        let next = &page.records[0];
        assert_eq!(
            next.position,
            CommitPosition::new(cursor.sequence + 1, 0),
            "concurrent {concurrent}"
        );
        assert!(
            next.commit_time > floor,
            "the clock went back across the promotion"
        );
        assert_eq!(page.lineage.len(), 1);
        assert_eq!(page.lineage[0].from, cursor);
    }
}

#[test]
fn a_follower_ahead_of_a_promoted_follower_is_told_to_install_a_snapshot_and_recovers() {
    for concurrent in MODES {
        let (p, a) = pair("lineage", concurrent);
        // B starts from the same snapshot as A.
        let b = Follower::open(&p.root.join("b")).unwrap();
        b.install_snapshot(&p.root.join("snap"), None).unwrap();
        for n in 0..4 {
            step(&p.primary, n);
        }
        catch_up(&a, &p.primary);
        for n in 4..20 {
            step(&p.primary, n);
        }
        catch_up(&b, &p.primary);
        assert!(b.cursor() > a.cursor());
        // A third follower C, behind A, which can continue on the new timeline.
        let c = Follower::open(&p.root.join("c")).unwrap();
        c.install_snapshot(&p.root.join("snap"), None).unwrap();
        let Pair {
            root,
            primary,
            _dir,
        } = p;
        drop(primary);
        let promoted = a.promote(mu(concurrent)).unwrap();
        for n in 40..42 {
            step(&promoted, n);
        }
        // B holds commits of the old primary the new one never had: refused, nothing changes.
        let before = image_of(b.records());
        let page = promoted.read_commit_log(b.cursor(), usize::MAX).unwrap();
        let err = if page.snapshot_required {
            SNAPSHOT_REQUIRED.to_string()
        } else {
            b.apply_page(&page).unwrap_err().code.to_string()
        };
        assert_eq!(err, SNAPSHOT_REQUIRED, "concurrent {concurrent}");
        assert_eq!(image_of(b.records()), before);
        // C was at the fork point or before it: it continues.
        catch_up(&c, &promoted);
        // B recovers from a snapshot of the new primary, even though it moves its position back.
        let (image, manifest) = primary_image(&promoted, &root.join("snap-new"));
        assert!(
            manifest.generation < b.sequence().unwrap(),
            "the case needs a snapshot behind the diverged follower: {} vs {}",
            manifest.generation,
            b.sequence().unwrap()
        );
        b.install_snapshot(&root.join("snap-new"), Some(&manifest))
            .unwrap();
        assert_eq!(image_of(b.records()), image);
        assert_eq!(image_of(c.records()), image);
        step(&promoted, 30);
        catch_up(&b, &promoted);
        catch_up(&c, &promoted);
        assert_eq!(image_of(b.records()), image_of(c.records()));
    }
}

#[test]
fn a_refused_snapshot_leaves_the_follower_byte_identical() {
    for concurrent in MODES {
        let (p, follower) = pair("refuse", concurrent);
        for n in 0..4 {
            step(&p.primary, n);
        }
        catch_up(&follower, &p.primary);
        let before = image_of(follower.records());
        let refused = |dir: &Path, manifest: Option<&SnapshotManifest>, why: &str| {
            assert!(follower.install_snapshot(dir, manifest).is_err(), "{why}");
            assert_eq!(image_of(follower.records()), before, "{why}");
        };
        // Stale: the first snapshot is behind the follower on the same history.
        refused(&p.root.join("snap"), None, "a stale snapshot");
        // A manifest that is not this snapshot's.
        let (_, old) = primary_image(&p.primary, &p.root.join("snap-a"));
        step(&p.primary, 9);
        primary_image(&p.primary, &p.root.join("snap-b"));
        refused(&p.root.join("snap-b"), Some(&old), "a manifest mismatch");
        // A brain without a log.
        let plain = Store::open_dir(&p.root.join("plain"), OpenOptions::default()).unwrap();
        plain
            .snapshot_to(&p.root.join("snap-plain"), &SnapshotOp::new())
            .unwrap();
        refused(&p.root.join("snap-plain"), None, "a brain without a log");
        // Another brain with a log.
        let other = Store::open_dir(&p.root.join("other"), mu(concurrent)).unwrap();
        for n in 0..12 {
            step(&other, n);
        }
        other
            .snapshot_to(&p.root.join("snap-other"), &SnapshotOp::new())
            .unwrap();
        refused(&p.root.join("snap-other"), None, "another brain");
        // A snapshot whose log meta disagrees with its record file.
        drop(other);
        std::fs::remove_dir_all(p.root.join("snap-other")).unwrap();
        let (_, _) = primary_image(&p.primary, &p.root.join("snap-c"));
        {
            let kv = RedbKv::open_path(&p.root.join("snap-c/records.redb")).unwrap();
            let read = kv.snapshot().unwrap();
            let mut meta = gbrain_store::commit_log::read_meta(&*read)
                .unwrap()
                .unwrap();
            drop(read);
            meta.newest = CommitPosition::new(meta.newest.sequence + 5, 0);
            let mut tx = kv.begin_write().unwrap();
            tx.put(
                &gbrain_store::commit_log::meta_key(),
                &serde_json::to_vec(&meta).unwrap(),
            )
            .unwrap();
            tx.commit().unwrap();
        }
        refused(
            &p.root.join("snap-c"),
            None,
            "a log meta past the record file",
        );
        // A trim point past the log's newest, written without moving the snapshot's sequence (so
        // only the bounds check can refuse it).
        primary_image(&p.primary, &p.root.join("snap-d"));
        edit_snapshot(&p.root.join("snap-d"), |kv, tx| {
            let mut meta = gbrain_store::commit_log::read_meta(&*kv.snapshot().unwrap())
                .unwrap()
                .unwrap();
            meta.trimmed_through = Some(CommitPosition::new(meta.newest.sequence + 3, 0));
            tx.put(
                &gbrain_store::commit_log::meta_key(),
                &serde_json::to_vec(&meta).unwrap(),
            )
        });
        let err = follower
            .install_snapshot(&p.root.join("snap-d"), None)
            .unwrap_err();
        assert!(err.message.contains("log bounds disagree"), "{err:?}");
        assert_eq!(image_of(follower.records()), before);
        // A corrupt retained record hidden behind a trim point at the newest commit.
        primary_image(&p.primary, &p.root.join("snap-f"));
        edit_snapshot(&p.root.join("snap-f"), |kv, tx| {
            let mut meta = gbrain_store::commit_log::read_meta(&*kv.snapshot().unwrap())
                .unwrap()
                .unwrap();
            let newest = meta.newest;
            meta.trimmed_through = Some(newest);
            tx.put(
                &gbrain_store::commit_log::meta_key(),
                &serde_json::to_vec(&meta).unwrap(),
            )?;
            tx.put(
                &gbrain_store::commit_log::record_key(newest),
                &[2, 0xFF, 0xFF],
            )
        });
        let err = follower
            .install_snapshot(&p.root.join("snap-f"), None)
            .unwrap_err();
        assert!(
            err.message.contains("at or before its trim point"),
            "{err:?}"
        );
        assert_eq!(image_of(follower.records()), before);
        // A FORMAT that names another brain than the records.
        primary_image(&p.primary, &p.root.join("snap-e"));
        let mut format: serde_json::Value =
            serde_json::from_slice(&std::fs::read(p.root.join("snap-e/FORMAT")).unwrap()).unwrap();
        format["brain_id"] = json!("00000000-0000-4000-8000-000000000000");
        std::fs::write(
            p.root.join("snap-e/FORMAT"),
            serde_json::to_vec(&format).unwrap(),
        )
        .unwrap();
        refused(&p.root.join("snap-e"), None, "a FORMAT of another brain");
    }
}

/// Edits a snapshot's record file in one write that keeps its commit sequence.
fn edit_snapshot(
    dir: &Path,
    f: impl FnOnce(&RedbKv, &mut dyn gbrain_store::kv::KvWrite) -> gbrain_store::error::Result<()>,
) {
    let kv = RedbKv::open_path(&dir.join("records.redb")).unwrap();
    let sequence = kv.version().unwrap();
    kv.replica_write(sequence, None, |tx| f(&kv, tx)).unwrap();
}

/// A follower record file that needs recovery and holds a newer format: refused, every byte as it
/// was (the format is judged on a recovered copy, not on the file).
#[test]
fn a_follower_that_needs_recovery_and_holds_a_newer_format_is_refused_without_a_change() {
    let (p, follower) = pair("newer-unclean", false);
    drop(follower);
    let dir = p.root.join("follower");
    let kv = RedbKv::open_path(&dir.join("records.redb")).unwrap();
    let sequence = kv.version().unwrap();
    kv.replica_write(sequence, None, |tx| {
        let mut format: serde_json::Value =
            serde_json::from_slice(&tx.get(&gbrain_store::keys::meta("format"))?.unwrap()).unwrap();
        format["format_version"] = json!(99);
        tx.put(
            &gbrain_store::keys::meta("format"),
            &serde_json::to_vec(&format).unwrap(),
        )
    })
    .unwrap();
    // An unclean stop: copy the file while the handle is still open; the copy has no FORMAT.
    let crashed = p.root.join("crashed");
    std::fs::create_dir_all(&crashed).unwrap();
    std::fs::copy(dir.join("records.redb"), crashed.join("records.redb")).unwrap();
    std::mem::forget(kv);
    let bytes = std::fs::read(crashed.join("records.redb")).unwrap();
    assert!(
        gbrain_store::redb_kv::peek(
            &crashed.join("records.redb"),
            &gbrain_store::keys::meta("format")
        )
        .is_none(),
        "the copy must need recovery for this case"
    );
    let err = Follower::open(&crashed).err().unwrap();
    assert_eq!(err.code, gbrain_store::error::FORMAT_UNKNOWN, "{err:?}");
    assert_eq!(
        std::fs::read(crashed.join("records.redb")).unwrap(),
        bytes,
        "the refused open changed the file"
    );
    assert_eq!(
        std::fs::read_dir(&crashed).unwrap().count(),
        1,
        "the check copy was left behind"
    );
}

#[test]
fn records_of_another_brain_are_refused() {
    for concurrent in MODES {
        let (p, follower) = pair("other-brain", concurrent);
        let other = Store::open_dir(&p.root.join("other"), mu(concurrent)).unwrap();
        for n in 0..20 {
            step(&other, n);
            step(&p.primary, n);
        }
        catch_up(&follower, &p.primary);
        let before = image_of(follower.records());
        let page = other
            .read_commit_log(follower.cursor(), usize::MAX)
            .unwrap();
        let foreign = if page.snapshot_required {
            other.read_commit_log(None, usize::MAX).unwrap()
        } else {
            page
        };
        let err = follower.apply_page(&foreign).unwrap_err();
        assert_eq!(err.code, gbrain_store::error::INVALID_STATE, "{err:?}");
        assert_eq!(image_of(follower.records()), before);
    }
}

#[test]
fn a_follower_of_a_newer_format_is_refused_without_a_change() {
    let (p, follower) = pair("newer-format", false);
    drop(follower);
    let records = p.root.join("follower/records.redb");
    {
        let kv = RedbKv::open_path(&records).unwrap();
        let read = kv.snapshot().unwrap();
        let mut format: serde_json::Value = serde_json::from_slice(
            &read
                .get(&gbrain_store::keys::meta("format"))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        drop(read);
        format["format_version"] = json!(99);
        let mut tx = kv.begin_write().unwrap();
        tx.put(
            &gbrain_store::keys::meta("format"),
            &serde_json::to_vec(&format).unwrap(),
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let bytes = std::fs::read(&records).unwrap();
    assert_eq!(
        Follower::open(&p.root.join("follower")).err().unwrap().code,
        gbrain_store::error::FORMAT_UNKNOWN
    );
    assert_eq!(
        std::fs::read(&records).unwrap(),
        bytes,
        "the refused open changed the record file"
    );
}

#[test]
fn a_refused_promotion_leaves_the_follower_unchanged() {
    let (p, follower) = pair("promote-refused", false);
    step(&p.primary, 1);
    catch_up(&follower, &p.primary);
    let before = image_of(follower.records());
    let dir = p.root.join("follower");
    let Pair { primary, .. } = &p;
    let _ = primary;
    let mut no_host = mu(false);
    no_host.multiuser_writes.host_id = None;
    assert!(follower.promote(no_host).is_err());
    let follower = Follower::open(&dir).unwrap();
    assert_eq!(
        image_of(follower.records()),
        before,
        "the refused promotion changed the follower"
    );
    assert!(follower.lineage().is_empty());
}

/// Installs and applies racing on one follower: whatever order they run in, the follower ends at
/// a state the primary had, with its cursor at its commit sequence.
#[test]
fn concurrent_install_and_apply_leave_a_state_the_primary_had() {
    for concurrent in MODES {
        let (p, follower) = pair("race", concurrent);
        for n in 0..10 {
            step(&p.primary, n);
        }
        let (later, manifest) = primary_image(&p.primary, &p.root.join("snap-later"));
        let page = p
            .primary
            .read_commit_log(follower.cursor(), usize::MAX)
            .unwrap();
        let follower = Arc::new(follower);
        for round in 0..20 {
            let f = follower.clone();
            let snap = p.root.join("snap-later");
            let m = manifest.clone();
            let installer = std::thread::spawn(move || {
                let _ = f.install_snapshot(&snap, Some(&m));
            });
            let _ = follower.apply_page(&page);
            installer.join().unwrap();
            let image = image_of(follower.records());
            assert_eq!(image, later, "concurrent {concurrent}, round {round}");
            assert_eq!(
                follower.cursor().unwrap().sequence,
                follower.sequence().unwrap()
            );
        }
    }
}

#[derive(Debug)]
struct Backend(SimFile);

impl gbrain_store::FileBackend for Backend {
    fn size(&self) -> std::io::Result<u64> {
        self.0.len()
    }
    fn read_at(&self, o: u64, b: &mut [u8]) -> std::io::Result<()> {
        self.0.read_at(o, b)
    }
    fn write_at(&self, o: u64, d: &[u8]) -> std::io::Result<()> {
        self.0.write_at(o, d)
    }
    fn set_len(&self, l: u64) -> std::io::Result<()> {
        self.0.set_len(l)
    }
    fn sync(&self) -> std::io::Result<()> {
        self.0.sync()
    }
}

fn sim_follower(disk: &SimDisk) -> Follower {
    Follower::over(
        RedbKv::open_backend(Box::new(Backend(disk.open("f.redb")))).unwrap(),
        None,
    )
    .unwrap()
}

/// A crash at every I/O call of one install and of one multi-record apply: after the reboot the
/// follower is at the position before or after the call, with exactly the primary's state there,
/// and it then catches up to the primary.
#[test]
fn a_crash_mid_install_or_mid_apply_recovers_to_a_consistent_position() {
    let modes = [
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    for concurrent in MODES {
        let (p, _) = pair("crash", concurrent);
        let (installed, manifest) = primary_image(&p.primary, &p.root.join("snap"));
        for n in 0..6 {
            step(&p.primary, n);
        }
        let page = p.primary.read_commit_log(None, usize::MAX).unwrap();
        let (applied_image, _) = primary_image(&p.primary, &p.root.join("snap-after"));
        let page = gbrain_store::commit_log::LogPage {
            records: page
                .records
                .into_iter()
                .filter(|r| r.position > manifest_cursor(&installed))
                .collect(),
            ..page
        };
        assert!(page.records.len() >= 4);
        // Calibration: the I/O of the install and of the apply on an honest disk.
        let honest = SimDisk::new(11, FaultPlan::none());
        let f = sim_follower(&honest);
        let start = honest.stats().io_ops;
        f.install_snapshot(&p.root.join("snap"), Some(&manifest))
            .unwrap();
        let mid = honest.stats().io_ops;
        f.apply_page(&page).unwrap();
        let end = honest.stats().io_ops;
        assert_eq!(image_of(f.records()), applied_image);
        drop(f);
        let (mut outcomes, mut points) = (BTreeMap::new(), 0);
        for k in start..=end {
            let disk = SimDisk::new(11, FaultPlan::none());
            let f = sim_follower(&disk);
            assert_eq!(disk.stats().io_ops, start);
            disk.set_plan(FaultPlan {
                fsync_error_pm: 0,
                fsync_lie_pm: 0,
                crash_at_op: Some(k + 1),
                crash_mode: modes[(k as usize) % modes.len()],
            });
            let in_install = k < mid;
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if f.install_snapshot(&p.root.join("snap"), Some(&manifest))
                    .is_ok()
                {
                    let _ = f.apply_page(&page);
                }
            }));
            disk.crash_now();
            drop(f);
            disk.reboot();
            disk.set_plan(FaultPlan::none());
            let f = sim_follower(&disk);
            let image = image_of(f.records());
            let at = match f.cursor() {
                None => {
                    assert!(
                        image.keys.is_empty(),
                        "crash at I/O {k}: an empty follower holds keys"
                    );
                    "empty"
                }
                Some(_) if image == installed => "installed",
                Some(_) if image == applied_image => "applied",
                Some(c) => panic!(
                    "crash at I/O {k} (in install: {in_install}): the follower at {} matches no primary state",
                    c.token()
                ),
            };
            *outcomes.entry(at).or_insert(0) += 1;
            points += 1;
            // And it goes on to the end from there.
            if f.cursor().is_none() {
                f.install_snapshot(&p.root.join("snap"), Some(&manifest))
                    .unwrap();
            }
            f.apply_page(&page).unwrap();
            assert_eq!(
                image_of(f.records()),
                applied_image,
                "crash at I/O {k}: catching up"
            );
        }
        eprintln!("concurrent {concurrent}: {points} crash points: {outcomes:?}");
        assert!(outcomes.contains_key("empty") && outcomes.contains_key("applied"));
        assert!(
            outcomes.contains_key("installed"),
            "no crash landed between the install and the apply"
        );
    }
}

/// The follower's cursor as an installed image says (its log meta's `newest`).
fn manifest_cursor(image: &Image) -> CommitPosition {
    let meta: gbrain_store::commit_log::LogMeta =
        serde_json::from_slice(&image.keys[&gbrain_store::commit_log::meta_key()]).unwrap();
    meta.newest
}

/// What a snapshot install costs (loss list): a 10,000-page brain, a fresh follower, median of 3.
/// A measurement, not a gate: `cargo test --release --test follower -- --ignored --nocapture install_cost`.
#[test]
#[ignore = "measurement"]
fn install_cost_on_a_10k_page_brain() {
    let dir = TempDir::new("install-cost");
    let root = dir.path();
    let primary = Store::open_dir(&root.join("primary"), mu(true)).unwrap();
    let body = "word ".repeat(200);
    for chunk in 0..100u64 {
        let tx = primary.begin_transaction(false).unwrap();
        for i in 0..100u64 {
            let n = chunk * 100 + i;
            tx.submit_page_mutation(
                &mutation(n + 1, &format!("notes/page-{n:05}"), &format!("{body} {n}")),
                None,
            )
            .unwrap();
        }
        tx.commit_transaction().unwrap();
    }
    let manifest = primary
        .snapshot_to(&root.join("snap"), &SnapshotOp::new())
        .unwrap();
    let bytes: u64 = std::fs::read_dir(root.join("snap"))
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    let mut ms = Vec::new();
    for run in 0..3 {
        let target = root.join(format!("follower-{run}"));
        let follower = Follower::open(&target).unwrap();
        let start = std::time::Instant::now();
        follower
            .install_snapshot(&root.join("snap"), Some(&manifest))
            .unwrap();
        ms.push(start.elapsed().as_millis());
        drop(follower);
        std::fs::remove_dir_all(&target).unwrap();
    }
    let mut sorted = ms.clone();
    sorted.sort();
    println!(
        "install of a 10,000-page snapshot ({} keys, {bytes} bytes): runs {ms:?} ms, median {} ms",
        manifest.keys, sorted[1]
    );
}
