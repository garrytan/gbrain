//! A follower that copies a commit log brain from its primary's log, snapshot install and
//! promotion (`follower.rs`, rust/docs/store/commit-log.md "Followers and promotion"). Every case
//! runs with the primary on the single-writer and the optimistic store. The ground truth for "the
//! follower equals the primary at position P" is a snapshot of the primary taken at P: every key
//! (the log's included), the commit sequence and the durable commit time.

mod common;

use common::TempDir;
use gbrain_sim::{CrashMode, FaultPlan, SimDisk, SimFile};
use gbrain_store::commit_log::CommitPosition;
use gbrain_store::diverged_tail::{DIVERGED_TAIL, ExportCrash, read_diverged_tail};
use gbrain_store::follower::{Follower, OldPrimaryStopped, PROMOTION_PARTIAL, SNAPSHOT_REQUIRED};
use gbrain_store::journal::PageMutation;
use gbrain_store::kv::Kv;
use gbrain_store::redb_kv::{RedbKv, RedbReadOnlyKv, read_commit_time};
use gbrain_store::snapshot::{SnapshotManifest, SnapshotOp};
use gbrain_store::takeover::TakeoverSettings;
use gbrain_store::{Env, MultiUserWrites, OpenOptions, Store};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
const MODES: [bool; 2] = [false, true];

/// Promotes a follower whose primary never took the primary lease (these cases drop the primary):
/// the caller attests it stopped (`follower.rs`, promotion fence).
fn promote_dropped(follower: Follower, options: OpenOptions) -> gbrain_store::Result<Store> {
    let stopped = OldPrimaryStopped::attest("test: the primary was dropped before the promotion")?;
    follower.promote_with(
        options,
        Arc::new(gbrain_store::SystemEnv),
        &TakeoverSettings::default(),
        Some(&stopped),
    )
}

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
        let promoted = promote_dropped(follower, mu(concurrent)).unwrap();
        promoted.set_config("test.after", "1").unwrap();
        let page = promoted.read_commit_log(Some(cursor), 10).unwrap();
        // The new timeline's first commit is its promotion note, then the write.
        assert_eq!(page.records.len(), 2);
        let (note, next) = (&page.records[0], &page.records[1]);
        assert_eq!(
            note.position,
            CommitPosition::new(cursor.sequence + 1, 0),
            "concurrent {concurrent}"
        );
        assert_eq!(
            next.position,
            CommitPosition::new(cursor.sequence + 2, 0),
            "concurrent {concurrent}"
        );
        assert!(
            note.commit_time > floor && next.commit_time > note.commit_time,
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
        let promoted = promote_dropped(a, mu(concurrent)).unwrap();
        for n in 40..42 {
            step(&promoted, n);
        }
        // B holds commits of the old primary the new one never had: refused, nothing changes.
        let before = image_of(b.records());
        let page = promoted.read_commit_log(b.cursor(), usize::MAX).unwrap();
        // The records past the fork exist only in B: an apply refuses `diverged_tail` (a page the
        // log cannot serve is `snapshot_required`, and the install below refuses the same way).
        let err = if page.snapshot_required {
            DIVERGED_TAIL.to_string()
        } else {
            b.apply_page(&page).unwrap_err().code.to_string()
        };
        assert_eq!(err, DIVERGED_TAIL, "concurrent {concurrent}");
        assert_eq!(image_of(b.records()), before);
        // C was at the fork point or before it: it continues.
        catch_up(&c, &promoted);
        // B recovers from a snapshot of the new primary, even though it moves its position back,
        // but only after its tail is exported (`diverged_tail.rs`).
        let (image, manifest) = primary_image(&promoted, &root.join("snap-new"));
        assert!(
            manifest.generation < b.sequence().unwrap(),
            "the case needs a snapshot behind the diverged follower: {} vs {}",
            manifest.generation,
            b.sequence().unwrap()
        );
        let refused = b
            .install_snapshot(&root.join("snap-new"), Some(&manifest))
            .unwrap_err();
        assert_eq!(refused.code, DIVERGED_TAIL, "{refused}");
        assert_eq!(
            image_of(b.records()),
            before,
            "a refused install changes nothing"
        );
        let theirs = page.lineage.clone();
        b.export_diverged_tail(&root.join("b-tail"), &theirs)
            .unwrap();
        b.allow_install_over(&root.join("b-tail")).unwrap();
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
    assert!(promote_dropped(follower, no_host).is_err());
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

/// The clock floor is the newest durable commit time (`M\0ctime`, `Store::last_commit_time`; `clock_floor.rs`), and it
/// is brain state: a follower that replays the log holds the primary's floor exactly, and a promoted follower's first
/// commit time is strictly above it. No commit carries a separate floor row: the retired `~L 0x04` key is never
/// written. Both store modes.
#[test]
fn a_follower_carries_the_clock_floor_and_a_promotion_starts_above_it() {
    for concurrent in MODES {
        let dir = TempDir::new("floor-row");
        let root = dir.path();
        let far = 4_000_000_000_000_000;
        std::fs::create_dir_all(root.join("primary")).unwrap();
        let follower = Follower::open(&root.join("follower")).unwrap();
        let retired = gbrain_store::clock_floor::retired_high_water_key();
        {
            let base = RedbKv::open_path(&root.join("primary/records.redb")).unwrap();
            let kv: Arc<dyn Kv> = if concurrent {
                Arc::new(gbrain_store::occ_kv::OccKv::new(base).unwrap())
            } else {
                Arc::new(base)
            };
            let primary =
                Store::open_kv(kv, Arc::new(HandClock(AtomicI64::new(far))), mu(concurrent))
                    .unwrap();
            assert!(
                primary.multiuser(),
                "multi-user mode on through OpenOptions"
            );
            primary.set_config("test.a", "1").unwrap();
            let page = primary.read_commit_log(None, usize::MAX).unwrap();
            assert!(
                page.records
                    .iter()
                    .all(|r| r.ops.iter().all(|(k, _)| *k != retired)),
                "concurrent {concurrent}: a commit record carries the retired floor row"
            );
            assert!(
                primary.last_commit_time().unwrap().unwrap() >= far,
                "concurrent {concurrent}: the floor follows the store clock"
            );
        }
        let primary = Store::open_dir(&root.join("primary"), mu(concurrent)).unwrap();
        let manifest = primary
            .snapshot_to(&root.join("snap"), &SnapshotOp::new())
            .unwrap();
        follower
            .install_snapshot(&root.join("snap"), Some(&manifest))
            .unwrap();
        for n in 0..6 {
            step(&primary, n);
        }
        catch_up(&follower, &primary);
        let high = primary.last_commit_time().unwrap().unwrap();
        assert!(
            high >= far,
            "concurrent {concurrent}: the primary's floor {high}"
        );
        assert_eq!(
            follower.last_commit_time().unwrap(),
            high,
            "concurrent {concurrent}: the follower's floor is the primary's"
        );
        assert!(
            follower
                .records()
                .snapshot()
                .unwrap()
                .get(&retired)
                .unwrap()
                .is_none(),
            "concurrent {concurrent}: the follower holds a retired floor row"
        );
        drop(primary);
        let cursor = follower.cursor().unwrap();
        let promoted = promote_dropped(follower, mu(concurrent)).unwrap();
        promoted.set_config("test.after", "1").unwrap();
        // The first commit after the cursor (the promotion open's own upkeep commit, if any), not the newest one.
        let first = promoted.read_commit_log(Some(cursor), 1).unwrap();
        assert!(
            first.records[0].commit_time > high,
            "concurrent {concurrent}: the first promoted commit time is not above the floor"
        );
        assert!(
            promoted.clock_high_water().unwrap() > high,
            "concurrent {concurrent}: the promoted clock floor went back"
        );
    }
}

/// A fixed clock and UUID source, so a promotion's timeline and note are the same bytes on every run.
struct FixedEnv(i64);

impl Env for FixedEnv {
    fn now_micros(&self) -> i64 {
        self.0
    }
    fn new_uuid(&self) -> String {
        "0f0e0d0c-0b0a-4908-8706-050403020100".into()
    }
}

/// A crash at every I/O call of a promotion's durable step (`Follower::start_timeline`: the new timeline and its
/// promotion note in one redb transaction): after the reboot the follower is exactly as it was, or exactly promoted
/// (the new timeline with its note); never one without the other. From either it then finishes the promotion. A
/// promotion that returned an error but is on disk after the reboot named it `promotion_partial` (review finding 7,
/// fail-first on d30e72662a, which returned the plain I/O error).
#[test]
fn a_crash_at_every_io_of_a_promotion_leaves_the_follower_as_it_was_or_promoted() {
    let modes = [
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    let stopped = OldPrimaryStopped::attest("test: the primary was dropped").unwrap();
    for concurrent in MODES {
        let (p, _) = pair("crash-promote", concurrent);
        for n in 0..3 {
            step(&p.primary, n);
        }
        let (installed, manifest) = primary_image(&p.primary, &p.root.join("snap-promote"));
        let snap = p.root.join("snap-promote");
        let env = FixedEnv(gbrain_store::SystemEnv.now_micros() + 3_600_000_000);
        // Calibration: the I/O of the promotion's durable step on an honest disk.
        let honest = SimDisk::new(13, FaultPlan::none());
        let f = sim_follower(&honest);
        f.install_snapshot(&snap, Some(&manifest)).unwrap();
        let start = honest.stats().io_ops;
        let id = f.start_timeline(&env, 0, HOST, Some(&stopped)).unwrap();
        let end = honest.stats().io_ops;
        let promoted = image_of(f.records());
        assert_ne!(promoted, installed);
        assert_eq!(f.lineage().last().unwrap().id, id);
        drop(f);
        let mut outcomes = BTreeMap::new();
        for k in start..=end {
            let disk = SimDisk::new(13, FaultPlan::none());
            let f = sim_follower(&disk);
            f.install_snapshot(&snap, Some(&manifest)).unwrap();
            assert_eq!(disk.stats().io_ops, start);
            disk.set_plan(FaultPlan {
                fsync_error_pm: 0,
                fsync_lie_pm: 0,
                crash_at_op: Some(k + 1),
                crash_mode: modes[(k as usize) % modes.len()],
            });
            let returned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                f.start_timeline(&env, 0, HOST, Some(&stopped))
            }));
            disk.crash_now();
            drop(f);
            disk.reboot();
            disk.set_plan(FaultPlan::none());
            let f = sim_follower(&disk);
            let image = image_of(f.records());
            let at = if image == installed {
                assert!(
                    f.lineage().is_empty(),
                    "crash at I/O {k}: a lineage without its note"
                );
                let again = f.start_timeline(&env, 0, HOST, Some(&stopped)).unwrap();
                assert_eq!(again, id);
                assert_eq!(
                    image_of(f.records()),
                    promoted,
                    "crash at I/O {k}: finishing the promotion"
                );
                "as_it_was"
            } else if image == promoted {
                assert_eq!(f.lineage().last().unwrap().id, id);
                match &returned {
                    Ok(Err(e)) => {
                        assert!(
                            e.message.starts_with(PROMOTION_PARTIAL),
                            "crash at I/O {k}: a promotion on disk returned {e}, not {PROMOTION_PARTIAL}"
                        );
                        "promoted_partial"
                    }
                    _ => "promoted",
                }
            } else {
                panic!("crash at I/O {k}: the follower is neither as it was nor promoted");
            };
            *outcomes.entry(at).or_insert(0) += 1;
        }
        eprintln!(
            "concurrent {concurrent}: {} crash points: {outcomes:?}",
            end - start + 1
        );
        assert!(outcomes.contains_key("as_it_was"));
        assert!(
            outcomes.contains_key("promoted") || outcomes.contains_key("promoted_partial"),
            "{outcomes:?}"
        );
    }
}

// --- Diverged-tail recovery (lane L2, mu-replica-ack; `diverged_tail.rs`) ---------------------------------------------

/// A follower B that applied commits of the old primary past the point where a promoted follower's
/// timeline starts, and that new primary with two commits of its own.
struct Diverged {
    _dir: TempDir,
    root: PathBuf,
    promoted: Store,
    b: Follower,
    theirs: Vec<gbrain_store::commit_log::Timeline>,
    fork: CommitPosition,
}

fn diverged(name: &str, concurrent: bool, b_retention: Option<u64>) -> Diverged {
    let (p, a) = pair(name, concurrent);
    let mut b = Follower::open(&p.root.join("b")).unwrap();
    if let Some(bytes) = b_retention {
        b = b.with_retention(bytes).unwrap();
    }
    b.install_snapshot(&p.root.join("snap"), None).unwrap();
    for n in 0..4 {
        step(&p.primary, n);
    }
    catch_up(&a, &p.primary);
    let fork = a.cursor().unwrap();
    // Only B sees these: the old primary's commits after A stopped.
    p.primary
        .set_config("test.tail-only", "kept by the export")
        .unwrap();
    for n in 4..20 {
        step(&p.primary, n);
    }
    catch_up(&b, &p.primary);
    let Pair {
        _dir,
        root,
        primary,
    } = p;
    drop(primary);
    let promoted = promote_dropped(a, mu(concurrent)).unwrap();
    step(&promoted, 40);
    let theirs = promoted.read_commit_log(None, 1).unwrap().lineage;
    Diverged {
        _dir,
        root,
        promoted,
        b,
        theirs,
        fork,
    }
}

fn files_of(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

/// Fail-first: on e28c821e6c the install replaced B's tail silently (and `export_diverged_tail` did not exist).
#[test]
fn an_apply_or_install_over_a_diverged_tail_is_refused_until_it_is_exported() {
    for concurrent in MODES {
        let d = diverged("tail-refuse", concurrent, None);
        let before = image_of(d.b.records());
        let cursor = d.b.cursor().unwrap();
        assert!(cursor > d.fork);
        // An apply of the new primary's records, from B's cursor or from the fork.
        let page = d
            .promoted
            .read_commit_log(Some(d.fork), usize::MAX)
            .unwrap();
        let raw: Vec<(CommitPosition, Vec<u8>)> = page
            .records
            .iter()
            .map(|r| {
                (
                    r.position,
                    gbrain_store::commit_log::encode_commit_record(r),
                )
            })
            .collect();
        let err =
            d.b.apply_raw(&page.brain_id, &page.lineage, &raw)
                .unwrap_err();
        assert_eq!(err.code, DIVERGED_TAIL, "{err}");
        assert!(
            err.message.contains(&d.fork.token()) && err.message.contains(&cursor.token()),
            "the refusal names the fork and the cursor: {err}"
        );
        let (_, manifest) = primary_image(&d.promoted, &d.root.join("snap-new"));
        let err =
            d.b.install_snapshot(&d.root.join("snap-new"), Some(&manifest))
                .unwrap_err();
        assert_eq!(err.code, DIVERGED_TAIL, "{err}");
        assert_eq!(image_of(d.b.records()), before, "concurrent {concurrent}");
        assert_eq!(d.b.cursor(), Some(cursor));
    }
}

/// Fail-first: on e28c821e6c there was no export, and the install lost `test.tail-only`.
#[test]
fn after_an_export_the_install_goes_ahead_and_the_export_keeps_the_tail_byte_for_byte() {
    for concurrent in MODES {
        let d = diverged("tail-export", concurrent, None);
        let before = image_of(d.b.records());
        let cursor = d.b.cursor().unwrap();
        let out = d.root.join("b-tail");
        let header = d.b.export_diverged_tail(&out, &d.theirs).unwrap();
        assert_eq!((header.fork, header.cursor), (d.fork, cursor));
        assert_eq!(header.theirs_lineage, d.theirs);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&out), 0o700);
            for name in [
                "records.redb",
                "FORMAT",
                "SNAPSHOT.json",
                "tail.jsonl",
                "MANIFEST.json",
            ] {
                assert_eq!(mode(&out.join(name)), 0o600, "{name}");
            }
        }
        assert!(!out.join("REPLICA-MARK").exists());
        let written = files_of(&out);
        // The tail holds every record past the fork, as B stored them.
        let tail = read_diverged_tail(&out).unwrap();
        let page = d.b.records();
        let (read, _) = page.versioned_snapshot().unwrap();
        let mut mine = Vec::new();
        let mut from = gbrain_store::commit_log::record_key(d.fork);
        from.push(0);
        read.scan(
            &from,
            &[gbrain_store::commit_log::COMMIT_LOG + 1],
            false,
            &mut |k, v| {
                let r = gbrain_store::commit_log::decode_record(k, v).unwrap();
                mine.push((r.position, v.to_vec()));
                true
            },
        )
        .unwrap();
        drop(read);
        assert_eq!(tail.records, mine);
        assert_eq!(tail.records.last().map(|r| r.0), Some(cursor));
        // The install goes ahead once the export is allowed.
        d.b.allow_install_over(&out).unwrap();
        let (image, manifest) = primary_image(&d.promoted, &d.root.join("snap-new"));
        d.b.install_snapshot(&d.root.join("snap-new"), Some(&manifest))
            .unwrap();
        assert_eq!(image_of(d.b.records()), image);
        // The export did not change, and its image is B before the install, every key.
        assert_eq!(files_of(&out), written, "concurrent {concurrent}");
        let exported = RedbReadOnlyKv::open_path(&out.join("records.redb")).unwrap();
        assert_eq!(image_of(&exported), before);
        // The permission covered that one install.
        d.b.allow_install_over(&out).unwrap_err();
        // B follows the new primary again.
        step(&d.promoted, 41);
        catch_up(&d.b, &d.promoted);
        let (image, _) = primary_image(&d.promoted, &d.root.join("snap-n"));
        assert_eq!(image_of(d.b.records()), image);
    }
}

#[test]
fn a_value_whose_records_retention_trimmed_is_kept_by_the_export_image() {
    for concurrent in MODES {
        let d = diverged("tail-trim", concurrent, Some(1));
        let out = d.root.join("b-tail");
        let header = d.b.export_diverged_tail(&out, &d.theirs).unwrap();
        let trimmed = header.trimmed_through.expect("retention trimmed B's log");
        assert!(
            trimmed > d.fork,
            "the case needs a trimmed tail: {header:?}"
        );
        let tail = read_diverged_tail(&out).unwrap();
        assert!(tail.records.iter().all(|(p, _)| *p > trimmed));
        let exported = Store::open_dir(
            &{
                // A read-only open of a copy: the export itself stays untouched.
                let copy = d.root.join("export-copy");
                std::fs::create_dir_all(&copy).unwrap();
                for name in ["records.redb", "FORMAT"] {
                    std::fs::copy(out.join(name), copy.join(name)).unwrap();
                }
                copy
            },
            mu(concurrent),
        )
        .unwrap();
        assert_eq!(
            exported.get_config("test.tail-only").unwrap().as_deref(),
            Some("kept by the export"),
            "concurrent {concurrent}"
        );
    }
}

#[test]
fn an_export_refuses_unsafe_destinations_and_a_follower_without_a_tail() {
    let d = diverged("tail-unsafe", false, None);
    let before = image_of(d.b.records());
    let taken = d.root.join("taken");
    std::fs::create_dir(&taken).unwrap();
    for (dest, why) in [
        (taken.clone(), "an existing directory"),
        (d.root.join("b").join("inside"), "inside the follower"),
    ] {
        let err = d.b.export_diverged_tail(&dest, &d.theirs).unwrap_err();
        assert_eq!(
            err.code,
            gbrain_store::error::INVALID_ARGUMENT,
            "{why}: {err}"
        );
    }
    #[cfg(unix)]
    {
        let link = d.root.join("link");
        std::os::unix::fs::symlink(&taken, &link).unwrap();
        let err =
            d.b.export_diverged_tail(&link.join("out"), &d.theirs)
                .unwrap_err();
        assert_eq!(err.code, gbrain_store::error::INVALID_ARGUMENT, "{err}");
    }
    // No tail against B's own history.
    let err =
        d.b.export_diverged_tail(&d.root.join("none"), &d.b.lineage())
            .unwrap_err();
    assert_eq!(err.code, gbrain_store::error::INVALID_STATE, "{err}");
    assert!(!d.root.join("none").exists());
    assert_eq!(image_of(d.b.records()), before);
    // A complete export of B permits nothing on another follower.
    let out = d.root.join("b-tail");
    d.b.export_diverged_tail(&out, &d.theirs).unwrap();
    let empty = Follower::open(&d.root.join("empty")).unwrap();
    assert!(empty.allow_install_over(&out).is_err());
    std::fs::remove_dir_all(&out).unwrap();
    let (_, manifest) = primary_image(&d.promoted, &d.root.join("snap-new"));
    assert_eq!(
        d.b.install_snapshot(&d.root.join("snap-new"), Some(&manifest))
            .unwrap_err()
            .code,
        DIVERGED_TAIL,
        "a refused export permits nothing"
    );
}

/// Ember's adds: an export interrupted before its manifest, or one whose files changed, never permits the install.
#[test]
fn an_interrupted_or_tampered_export_never_permits_the_install() {
    let d = diverged("tail-crash", true, None);
    let before = image_of(d.b.records());
    let (_, manifest) = primary_image(&d.promoted, &d.root.join("snap-new"));
    let install = || {
        d.b.install_snapshot(&d.root.join("snap-new"), Some(&manifest))
    };
    for (n, crash) in [
        ExportCrash::Reserved,
        ExportCrash::Image,
        ExportCrash::Tail,
        ExportCrash::ManifestTemp,
    ]
    .into_iter()
    .enumerate()
    {
        let out = d.root.join(format!("crash-{n}"));
        d.b.export_diverged_tail_with(&out, &d.theirs, Some(crash))
            .unwrap_err();
        assert!(out.exists(), "{crash:?} leaves what it wrote");
        let err = d.b.allow_install_over(&out).unwrap_err();
        assert_eq!(err.code, DIVERGED_TAIL, "{crash:?}: {err}");
        assert_eq!(install().unwrap_err().code, DIVERGED_TAIL, "{crash:?}");
        assert_eq!(image_of(d.b.records()), before, "{crash:?}");
    }
    // A complete export, then each file changed by one byte.
    let good = d.root.join("good");
    d.b.export_diverged_tail(&good, &d.theirs).unwrap();
    for name in [
        "tail.jsonl",
        "records.redb",
        "FORMAT",
        "SNAPSHOT.json",
        "MANIFEST.json",
    ] {
        let path = good.join(name);
        let original = std::fs::read(&path).unwrap();
        let mut bad = original.clone();
        let at = bad.len() / 2;
        bad[at] ^= 0x01;
        std::fs::write(&path, &bad).unwrap();
        let err = d.b.allow_install_over(&good).unwrap_err();
        assert_eq!(err.code, DIVERGED_TAIL, "{name}: {err}");
        assert!(
            !err.message.contains("bytes_b64"),
            "a refusal carries no record bytes"
        );
        assert_eq!(install().unwrap_err().code, DIVERGED_TAIL, "{name}");
        std::fs::write(&path, &original).unwrap();
    }
    // A restart forgets the permission; the export grants it again.
    d.b.allow_install_over(&good).unwrap();
    let Diverged {
        _dir,
        root,
        promoted,
        b,
        ..
    } = d;
    drop(b);
    let b = Follower::open(&root.join("b")).unwrap();
    assert_eq!(
        b.install_snapshot(&root.join("snap-new"), Some(&manifest))
            .unwrap_err()
            .code,
        DIVERGED_TAIL
    );
    b.allow_install_over(&good).unwrap();
    b.install_snapshot(&root.join("snap-new"), Some(&manifest))
        .unwrap();
    let (image, _) = primary_image(&promoted, &root.join("snap-after"));
    assert_eq!(image_of(b.records()), image);
}
