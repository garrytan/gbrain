//! Taking over as primary (lane L5, `takeover.rs`): the old primary is fenced before the follower promotes, and a
//! follower on another history is not continued. Both store modes.

mod common;

use common::TempDir;
use gbrain_store::follower::{Follower, SNAPSHOT_REQUIRED};
use gbrain_store::leases::lost_reason;
use gbrain_store::snapshot::SnapshotOp;
use gbrain_store::takeover::{PRIMARY_LEASE, continue_following, take_over};
use gbrain_store::write_origin::WriteOrigin;
use gbrain_store::{MultiUserWrites, OpenOptions, Store, SystemEnv};

const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";

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

fn catch_up(follower: &Follower, primary: &Store) {
    loop {
        let page = primary.read_commit_log(follower.cursor(), 50).unwrap();
        if page.records.is_empty() {
            return;
        }
        continue_following(follower, &page).unwrap();
    }
}

fn follower_of(primary: &Store, root: &std::path::Path, name: &str) -> Follower {
    let snap = root.join(format!("snap-{name}"));
    let manifest = primary.snapshot_to(&snap, &SnapshotOp::new()).unwrap();
    let f = Follower::open(&root.join(name)).unwrap();
    f.install_snapshot(&snap, Some(&manifest)).unwrap();
    f
}

#[test]
fn the_old_primary_is_fenced_before_the_follower_promotes_and_its_writes_are_refused_after() {
    for concurrent in [false, true] {
        let dir = TempDir::new("takeover-fence");
        let root = dir.path().to_path_buf();
        let primary = Store::open_dir(&root.join("primary"), mu(concurrent)).unwrap();
        let old = primary
            .acquire_lease(PRIMARY_LEASE, &origin("old"), 6_000)
            .unwrap()
            .unwrap();
        primary.set_config("before", "1").unwrap();
        let follower = follower_of(&primary, &root, "follower");
        catch_up(&follower, &primary);
        let replicated = gbrain_store::leases::read_lease_record(
            &*gbrain_store::kv::Kv::snapshot(follower.records()).unwrap(),
            PRIMARY_LEASE,
        )
        .unwrap()
        .expect("the primary lease is replicated with the data");
        assert_eq!(replicated.epoch, old.epoch, "{concurrent}");

        // Too early: the old primary's lease is still live; nothing is promoted (no new timeline).
        let lineage_before = follower.lineage();
        let early = match take_over(follower, &origin("new"), mu(concurrent), 60_000, &SystemEnv) {
            Ok(_) => panic!(
                "{concurrent}: promoted while the old lease was live; now={}",
                gbrain_store::Env::clock_micros(&SystemEnv)
            ),
            Err(e) => e,
        };
        assert!(
            early.message.starts_with("primary_live"),
            "{concurrent}: {early}"
        );
        let follower = Follower::open(&root.join("follower")).unwrap();
        assert!(
            follower.cursor().is_some(),
            "{concurrent}: the follower is still a follower"
        );
        assert_eq!(
            follower.lineage(),
            lineage_before,
            "{concurrent}: the refused takeover promoted the follower"
        );

        let wait_us =
            replicated.expires_at_us - gbrain_store::Env::clock_micros(&SystemEnv) + 100_000;
        std::thread::sleep(std::time::Duration::from_micros(wait_us.max(0) as u64));
        let (promoted, token) =
            take_over(follower, &origin("new"), mu(concurrent), 60_000, &SystemEnv).unwrap();
        assert_eq!(token.epoch, old.epoch + 1, "{concurrent}");

        // The old primary writes after the takeover: refused at its own commit (its lease no longer holds there) ...
        let e = primary
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
    }
}

#[test]
fn a_follower_on_another_lineage_is_not_continued() {
    for concurrent in [false, true] {
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
        let (new_primary, _) =
            take_over(a, &origin("a"), mu(concurrent), 60_000, &SystemEnv).unwrap();
        new_primary.set_config("after-promotion", "1").unwrap();
        let before = b.cursor();
        let page = new_primary.read_commit_log(b.cursor(), 50).unwrap();
        let e = continue_following(&b, &page).unwrap_err();
        assert_eq!(e.code, SNAPSHOT_REQUIRED, "{concurrent}: {e}");
        assert_eq!(b.cursor(), before, "{concurrent}: nothing applied");
    }
}
