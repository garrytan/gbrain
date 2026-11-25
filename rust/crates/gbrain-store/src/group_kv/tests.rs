//! Group commit on the single-writer record file: writes that queue up share one durable commit,
//! each write returns only after its group commits, a failed write or a failed commit keeps nothing
//! it should not, and readers never see a group before it commits.

use super::*;
use crate::error::STORE_IO;
use crate::redb_kv::RedbKv;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

/// A record file whose commits can be slowed (so writers queue behind one) or failed, and counted.
struct Probe {
    base: RedbKv,
    commits: Arc<AtomicUsize>,
    delay_ms: u64,
    fail_next: Arc<AtomicBool>,
}

struct ProbeWrite {
    inner: Box<dyn KvWrite>,
    commits: Arc<AtomicUsize>,
    delay_ms: u64,
    fail_next: Arc<AtomicBool>,
}

impl KvRead for ProbeWrite {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.inner.get(key)
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.inner.scan(start, end, reverse, f)
    }
}

impl KvWrite for ProbeWrite {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.inner.put(key, value)
    }
    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.inner.delete(key)
    }
    fn commit(self: Box<Self>) -> Result<u64> {
        std::thread::sleep(Duration::from_millis(self.delay_ms));
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(StoreError::new(STORE_IO, "injected commit failure"));
        }
        self.commits.fetch_add(1, Ordering::SeqCst);
        self.inner.commit()
    }
}

impl Kv for Probe {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        self.base.snapshot()
    }
    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
        self.base.versioned_snapshot()
    }
    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        Ok(Box::new(ProbeWrite {
            inner: self.base.begin_write()?,
            commits: self.commits.clone(),
            delay_ms: self.delay_ms,
            fail_next: self.fail_next.clone(),
        }))
    }
    fn version(&self) -> Result<u64> {
        self.base.version()
    }
}

struct Rig {
    kv: Arc<GroupKv>,
    commits: Arc<AtomicUsize>,
    fail_next: Arc<AtomicBool>,
}

fn rig(delay_ms: u64) -> Rig {
    let commits = Arc::new(AtomicUsize::new(0));
    let fail_next = Arc::new(AtomicBool::new(false));
    let base = RedbKv::open_backend(Box::<crate::test_support::MemFile>::default()).unwrap();
    let probe = Probe {
        base,
        commits: commits.clone(),
        delay_ms,
        fail_next: fail_next.clone(),
    };
    Rig {
        kv: Arc::new(GroupKv::new(Arc::new(probe))),
        commits,
        fail_next,
    }
}

fn key(writer: usize, i: usize) -> Vec<u8> {
    format!("w/{writer:03}/{i:04}").into_bytes()
}

/// One write: a key of its own and an id from a shared sequence, read back inside the write.
fn write_one(kv: &GroupKv, writer: usize, i: usize) -> Result<(u64, u64)> {
    let mut tx = kv.begin_write()?;
    let id = tx.allocate(b"Mnext_id", 1)?;
    tx.put(&key(writer, i), &id.to_be_bytes())?;
    assert_eq!(tx.get(&key(writer, i))?, Some(id.to_be_bytes().to_vec()));
    let seq = tx.commit()?;
    Ok((id, seq))
}

fn get(kv: &dyn Kv, key: &[u8]) -> Option<Vec<u8>> {
    kv.snapshot().unwrap().get(key).unwrap()
}

#[test]
fn one_writer_at_a_time_commits_each_write_on_its_own() {
    let rig = rig(0);
    let mut seqs = Vec::new();
    for i in 0..20 {
        let (id, seq) = write_one(&rig.kv, 0, i).unwrap();
        assert_eq!(id, i as u64 + 1);
        seqs.push(seq);
        assert_eq!(get(&*rig.kv, &key(0, i)), Some(id.to_be_bytes().to_vec()));
    }
    assert_eq!(rig.commits.load(Ordering::SeqCst), 20);
    assert_eq!(seqs, (1..=20).collect::<Vec<u64>>());
}

#[test]
fn writers_that_queue_share_a_commit_and_each_returns_after_it() {
    let rig = rig(20);
    let writers = 16;
    let per = 10;
    let ids = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for w in 0..writers {
            let (kv, ids) = (&rig.kv, &ids);
            scope.spawn(move || {
                for i in 0..per {
                    let (id, seq) = write_one(kv, w, i).unwrap();
                    // Returned means committed: a fresh reader sees the write and its sequence.
                    assert_eq!(get(&**kv, &key(w, i)), Some(id.to_be_bytes().to_vec()));
                    assert!(kv.version().unwrap() >= seq);
                    ids.lock().unwrap().push(id);
                }
            });
        }
    });
    let mut ids = ids.into_inner().unwrap();
    ids.sort();
    assert_eq!(
        ids,
        (1..=(writers * per) as u64).collect::<Vec<_>>(),
        "ids repeat or skip"
    );
    let commits = rig.commits.load(Ordering::SeqCst);
    assert!(
        commits < writers * per / 2,
        "{commits} commits for {} writes: the queued writers did not share commits",
        writers * per
    );
    for w in 0..writers {
        for i in 0..per {
            assert!(get(&*rig.kv, &key(w, i)).is_some());
        }
    }
}

/// Waits until `n` writers wait for a turn.
fn until_waiting(kv: &GroupKv, n: usize) {
    for _ in 0..2000 {
        if lock(&kv.shared).waiting >= n {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("no writer queued");
}

#[test]
fn a_group_is_invisible_until_it_commits_and_a_failed_write_keeps_nothing() {
    let rig = rig(0);
    let kv = rig.kv.clone();
    let mut first = kv.begin_write().unwrap();
    first.put(b"a", b"1").unwrap();
    std::thread::scope(|scope| {
        // The second writer queues behind the first, writes, then fails (drops its write).
        let second = scope.spawn(|| {
            let mut tx = kv.begin_write().unwrap();
            tx.put(b"b", b"2").unwrap();
            assert!(
                get(&*kv, b"a").is_none(),
                "a reader sees the group before it commits"
            );
            drop(tx);
        });
        until_waiting(&kv, 1);
        // The first write hands the group to the queued writer and waits for the commit.
        let seq = first.commit().unwrap();
        second.join().unwrap();
        assert!(seq >= 1);
    });
    assert_eq!(get(&*kv, b"a"), Some(b"1".to_vec()));
    assert_eq!(
        get(&*kv, b"b"),
        None,
        "a write that did not commit was kept"
    );
    assert_eq!(rig.commits.load(Ordering::SeqCst), 1);
}

#[test]
fn a_failed_commit_fails_every_write_of_the_group_and_keeps_none() {
    let rig = rig(0);
    let kv = rig.kv.clone();
    let mut first = kv.begin_write().unwrap();
    first.put(b"a", b"1").unwrap();
    rig.fail_next.store(true, Ordering::SeqCst);
    let second_result = std::thread::scope(|scope| {
        let second = scope.spawn(|| {
            let mut tx = kv.begin_write().unwrap();
            tx.put(b"b", b"2").unwrap();
            tx.commit()
        });
        until_waiting(&kv, 1);
        let first_result = first.commit();
        let second_result = second.join().unwrap();
        let first_err = first_result.unwrap_err();
        assert_eq!(first_err.code, STORE_IO);
        assert!(
            first_err.message.starts_with("record store commit failed"),
            "{}",
            first_err.message
        );
        second_result
    });
    assert_eq!(second_result.unwrap_err().code, STORE_IO);
    assert_eq!(get(&*kv, b"a"), None);
    assert_eq!(get(&*kv, b"b"), None);
    // The group may or may not be on disk: every later write is refused until the brain reopens.
    let refused = write_one(&kv, 9, 0).unwrap_err();
    assert_eq!(refused.code, STORE_IO);
    assert!(
        refused.message.contains("open the brain again"),
        "{}",
        refused.message
    );
    assert_eq!(get(&*kv, &key(9, 0)), None);
}

#[test]
fn an_exclusive_write_waits_for_the_open_group_and_commits_alone() {
    let rig = rig(0);
    let kv = rig.kv.clone();
    let mut first = kv.begin_write().unwrap();
    first.put(b"a", b"1").unwrap();
    std::thread::scope(|scope| {
        let excl = scope.spawn(|| {
            let mut tx = kv.begin_write_exclusive().unwrap();
            // The group the first write was in committed before this write began.
            assert_eq!(tx.get(b"a").unwrap(), Some(b"1".to_vec()));
            tx.put(b"x", b"9").unwrap();
            tx.commit().unwrap()
        });
        std::thread::sleep(Duration::from_millis(20));
        first.commit().unwrap();
        excl.join().unwrap();
    });
    assert_eq!(get(&*kv, b"x"), Some(b"9".to_vec()));
    assert_eq!(rig.commits.load(Ordering::SeqCst), 2);
}

#[test]
fn reserved_keys_are_refused_inside_a_write() {
    let rig = rig(0);
    let mut tx = rig.kv.begin_write().unwrap();
    let err = tx.put(b"\0reserved", b"x").unwrap_err();
    assert_eq!(err.code, crate::error::INVALID_ARGUMENT, "{}", err.message);
}

#[test]
fn the_merged_scan_shows_the_write_s_own_puts_and_deletes_in_order() {
    let rig = rig(0);
    let mut tx = rig.kv.begin_write().unwrap();
    for k in ["b", "d", "f"] {
        tx.put(k.as_bytes(), b"base").unwrap();
    }
    tx.commit().unwrap();
    let mut tx = rig.kv.begin_write().unwrap();
    tx.put(b"a", b"new").unwrap();
    tx.put(b"d", b"changed").unwrap();
    tx.delete(b"f").unwrap();
    tx.put(b"g", b"new").unwrap();
    let mut seen = Vec::new();
    tx.scan(b"a", b"z", false, &mut |k, v| {
        seen.push(format!(
            "{}={}",
            String::from_utf8_lossy(k),
            String::from_utf8_lossy(v)
        ));
        true
    })
    .unwrap();
    assert_eq!(seen, ["a=new", "b=base", "d=changed", "g=new"]);
    let mut back = Vec::new();
    tx.scan(b"a", b"z", true, &mut |k, _| {
        back.push(String::from_utf8_lossy(k).into_owned());
        back.len() < 3
    })
    .unwrap();
    assert_eq!(back, ["g", "d", "b"]);
}
