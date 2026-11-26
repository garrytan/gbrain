//! The sticky member-access flag: config `access.restrictions_present = '1'`.
//!
//! PGLite and Postgres set it from the trigger `pages_access_mark_restricted` (schema
//! migration v282): after a page row is inserted, or its frontmatter is updated, and the new
//! frontmatter has a top-level `readable_by` key. v282 also sets it once, when it runs, if any
//! page row (soft-deleted or not) already has the key. Nothing here clears it.
//!
//! The store sets it in three places, so no page record with `readable_by` can sit in the store
//! while the flag is unset:
//!
//! - The page write hook (`pages::write_page`), in the same write as the record.
//! - Every store write handle (`Store::write` wraps its handle in [`FlaggingWriter`]): a put of a
//!   page record with the key sets the flag in the same write, whatever code path made the put.
//!   `pages::write_page` is the only such path today; the wrapper holds the rule for any later one.
//! - The open-time scan ([`scan_at_open`]): the first open of a brain that has no scan record
//!   reads every page record and sets the flag if one has the key, as v282 does. It covers a
//!   brain written by a build before the hook. It runs once per brain; a fresh brain records it
//!   as done when it is created. When the scan cannot write (a full disk, a record file that
//!   takes no writes), the open goes on and that process reads the flag as `'1'` if the brain
//!   holds a reader page, or if the scan could not finish its read (`Store::flag_assumed`).
//!
//! The trigger fires only when an UPDATE names the frontmatter column. The store sets the flag
//! on every write of a page that has `readable_by`. The flag is sticky, so the two differ only
//! after an operator unsets the flag by hand, and then the store sets it again sooner.
//!
//! The folder triggers `access_rules_mark_restricted` and `access_pending_coverage_mark_restricted`
//! set it after a rule or a pending prefix is inserted; [`FlaggingWriter`] sets it on the put of
//! either record (`access_rules.rs`). The trigger `access_members_mark_restricted` has its store
//! half in `access_members::insert_access_member`, in the same write as the member. See
//! `rust/docs/store/access-flag.md`.

use crate::error::{INVALID_STATE, Result, StoreError};
use crate::keys;
use crate::kv::{Kv, KvRead, KvWrite, scan_prefix};
use crate::pages::PageRecord;
use serde::Deserialize;
use serde::de::IgnoredAny;
use std::collections::BTreeMap;

/// The config key the flag lives under.
pub(crate) const RESTRICTIONS_PRESENT_KEY: &str = "access.restrictions_present";

/// The meta record the open-time scan writes when it is done (`keys::meta`).
pub(crate) const SCAN_DONE: &str = "access_flag_scan";

/// Sets the flag when `record` carries a top-level `readable_by` frontmatter key and the flag is
/// not already `'1'`.
pub(crate) fn mark_restricted(tx: &mut dyn KvWrite, record: &PageRecord) -> Result<()> {
    if !record.frontmatter.contains_key("readable_by") {
        return Ok(());
    }
    set_flag(tx)
}

/// Sets the flag to `'1'` unless it already is, as the trigger's `ON CONFLICT DO UPDATE` does.
fn set_flag(tx: &mut dyn KvWrite) -> Result<()> {
    let key = keys::text(keys::CONFIG, &[RESTRICTIONS_PRESENT_KEY]);
    if tx.get(&key)?.as_deref() == Some(b"1".as_slice()) {
        return Ok(());
    }
    tx.put(&key, b"1")
}

/// The frontmatter keys of a stored page record, without decoding their values.
#[derive(Deserialize)]
struct FrontmatterKeys {
    #[serde(default)]
    frontmatter: Option<BTreeMap<String, IgnoredAny>>,
}

/// True when the stored page record `value` has a top-level `readable_by` frontmatter key. A value
/// that does not decode counts as naming readers: the flag only makes reads stricter.
fn record_names_readers(value: &[u8]) -> bool {
    serde_json::from_slice::<FrontmatterKeys>(value).map_or(true, |r| {
        r.frontmatter.is_some_and(|f| f.contains_key("readable_by"))
    })
}

/// True for a key in the page record family (`keys::page`).
fn is_page_record(key: &[u8]) -> bool {
    key.first() == Some(&keys::PAGE)
}

/// Records the open-time scan as done: a fresh brain has no page to scan.
pub(crate) fn record_scan_done(tx: &mut dyn KvWrite) -> Result<()> {
    tx.put(&keys::meta(SCAN_DONE), b"1")
}

/// The open-time scan: on a brain with no scan record, sets the flag when any page record
/// (soft-deleted or not) has a top-level `readable_by` key, then writes the scan record, in one
/// write. A brain that has the record is not read again.
///
/// Returns whether this process must treat the brain as flagged without a stored flag: the scan
/// could not write (a full disk, a record file that takes no writes), and a read of the snapshot
/// found a reader page or could not finish. The open goes on in both cases; nothing is stored, so
/// the next open that can write runs the scan again.
pub(crate) fn scan_at_open(kv: &dyn Kv) -> Result<bool> {
    let done = keys::meta(SCAN_DONE);
    let snapshot = kv.snapshot()?;
    if snapshot.get(&done)?.is_some() {
        return Ok(false);
    }
    match scan_and_record(kv, &done) {
        Ok(()) => Ok(false),
        Err(_) => Ok(names_readers(&*snapshot).unwrap_or(true)),
    }
}

fn scan_and_record(kv: &dyn Kv, done: &[u8]) -> Result<()> {
    let mut tx = kv.begin_write()?;
    // Another handle may have run the scan between the read and this write.
    if tx.get(done)?.is_some() {
        return Ok(());
    }
    if names_readers(&*tx)? {
        set_flag(&mut *tx)?;
    }
    tx.put(done, b"1")?;
    tx.commit()?;
    Ok(())
}

/// Whether any page record in `read` has a top-level `readable_by` key; stops at the first.
fn names_readers(read: &dyn KvRead) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &[keys::PAGE], false, &mut |_, value| {
        found = record_names_readers(value);
        !found
    })?;
    Ok(found)
}

/// The flag value a config read returns for `key` when the open-time scan could not store the
/// flag ([`scan_at_open`] returned true): `'1'` for the flag key, else the stored value.
pub(crate) fn assumed_config(assumed: bool, key: &str, stored: Option<String>) -> Option<String> {
    if assumed && key == RESTRICTIONS_PRESENT_KEY {
        Some("1".to_string())
    } else {
        stored
    }
}

/// A store read handle on which the flag reads `'1'`, whatever the record file holds: every read of
/// a store whose open-time scan could not store the flag (`Store::flag_assumed`) goes through one
/// (`Store::read`), so a policy that reads the flag itself (the short member-access form in
/// `facts/privacy.rs`) fails closed as the config reads do (`assumed_config`).
pub(crate) struct AssumedFlagRead {
    inner: Box<dyn KvRead>,
    flag: Vec<u8>,
}

impl AssumedFlagRead {
    pub(crate) fn wrap(inner: Box<dyn KvRead>) -> Box<dyn KvRead> {
        Box::new(AssumedFlagRead {
            inner,
            flag: keys::text(keys::CONFIG, &[RESTRICTIONS_PRESENT_KEY]),
        })
    }
}

impl KvRead for AssumedFlagRead {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        if key == self.flag.as_slice() {
            return Ok(Some(b"1".to_vec()));
        }
        self.inner.get(key)
    }

    /// The inner scan with the flag's entry read as `'1'`, in key order, whether or not the record
    /// file holds it.
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let flag = self.flag.as_slice();
        if !(start <= flag && flag < end) {
            return self.inner.scan(start, end, reverse, f);
        }
        let (mut emitted, mut stopped) = (false, false);
        self.inner.scan(start, end, reverse, &mut |key, value| {
            let past = if reverse { key < flag } else { key > flag };
            if !emitted && (key == flag || past) {
                emitted = true;
                if !f(flag, b"1") {
                    stopped = true;
                    return false;
                }
                if key == flag {
                    return true;
                }
            }
            let more = f(key, value);
            stopped = !more;
            more
        })?;
        if !emitted && !stopped {
            f(flag, b"1");
        }
        Ok(())
    }
}

/// A store write handle that sets the flag on every put of a page record with a top-level
/// `readable_by` key, and on every put of a folder rule or a pending prefix (`access_rules.rs`,
/// the triggers `access_rules_mark_restricted` and `access_pending_coverage_mark_restricted`), in
/// the same write. It also stamps a page record put under a new key with the folder rules that
/// cover it (`access_policy::stamp_page_put`, the trigger `pages_access_stamp_folder_rules`).
/// `Store::write` hands every write closure one.
pub(crate) struct FlaggingWriter<'a>(pub(crate) &'a mut dyn KvWrite);

impl KvRead for FlaggingWriter<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.0.get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.0.scan(start, end, reverse, f)
    }
}

impl KvWrite for FlaggingWriter<'_> {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        let page = is_page_record(key);
        let prior = if page {
            self.0
                .get(key)?
                .and_then(|v| crate::access_policy::page_record_id(&v))
        } else {
            None
        };
        self.0.put(key, value)?;
        if page {
            crate::access_policy::stamp_page_put(self.0, prior, value)?;
        }
        if (page && record_names_readers(value)) || crate::access_rules::marks_restricted(key) {
            set_flag(self.0)?;
        }
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.0.delete(key)
    }

    fn commit(self: Box<Self>) -> Result<u64> {
        Err(StoreError::new(
            INVALID_STATE,
            "a store write handle commits with its write, not on its own",
        ))
    }

    fn allocate(&mut self, key: &[u8], count: u64) -> Result<u64> {
        self.0.allocate(key, count)
    }

    fn raise_counter(&mut self, key: &[u8], value: u64) -> Result<()> {
        self.0.raise_counter(key, value)
    }

    fn add_i64(&mut self, key: &[u8], delta: i64) -> Result<()> {
        self.0.add_i64(key, delta)
    }

    fn counter_below(&mut self, key: &[u8], cap: i64) -> Result<Option<i64>> {
        self.0.counter_below(key, cap)
    }
}

#[cfg(test)]
mod tests {
    //! A page record written outside `pages::write_page` still sets the flag: every store write
    //! handle sets it on the put of a page record with `readable_by`.

    use super::RESTRICTIONS_PRESENT_KEY as FLAG;
    use crate::Store;
    use crate::keys;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;
    use serde_json::{Value, json};

    fn put_open_page(store: &Store, slug: &str) {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": {"tags": ["a"]}
        }))
        .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
        store.put_page(slug, &input, &opts).unwrap();
    }

    /// Adds `readable_by` to the stored page record with a raw put: a page write that never calls
    /// `write_page`.
    fn name_readers_raw(store: &Store, slug: &str) {
        store
            .write(|tx| {
                let key = keys::page("default", slug);
                let mut record: Value = serde_json::from_slice(&tx.get(&key)?.unwrap())?;
                record["frontmatter"]["readable_by"] = json!(["alice-example"]);
                tx.put(&key, &serde_json::to_vec(&record)?)
            })
            .unwrap();
    }

    #[test]
    fn a_reader_page_put_outside_write_page_sets_the_flag() {
        let store = store();
        put_open_page(&store, "notes/closed");
        assert_eq!(store.get_config(FLAG).unwrap(), None);
        name_readers_raw(&store, "notes/closed");
        assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn a_reader_page_put_outside_write_page_in_a_transaction_sets_the_flag_at_commit() {
        let store = store();
        put_open_page(&store, "notes/closed");
        let tx = store.begin_transaction(false).unwrap();
        name_readers_raw(&tx, "notes/closed");
        tx.commit_transaction().unwrap();
        assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn a_rolled_back_reader_page_leaves_the_flag_unset() {
        let store = store();
        put_open_page(&store, "notes/closed");
        let tx = store.begin_transaction(false).unwrap();
        name_readers_raw(&tx, "notes/closed");
        tx.rollback_transaction().unwrap();
        assert_eq!(store.get_config(FLAG).unwrap(), None);
    }

    /// The source of every non-test module under `src/`, keyed by its path from `src/`.
    fn crate_sources() -> Vec<(String, String)> {
        fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    // The unit tests open their own handles; only the module code counts.
                    let code = text
                        .split("\n#[cfg(test)]\nmod tests {")
                        .next()
                        .unwrap()
                        .to_string();
                    let name = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push((name, code));
                }
            }
        }
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        walk(&root, &root, &mut out);
        out.sort();
        out
    }

    /// `bumpPageRetrievals` and the hard-delete cascade (`cascade::remove_page_rows`) write
    /// through the flagging handle: `bump_page_retrievals` writes with `Store::write`, both arms of
    /// `Store::write` run the closure through `write_chain`, `write_chain` wraps the handle in
    /// `FlaggingWriter`, and no module outside this list opens a raw write handle, so the `tx` the
    /// cascade gets is always a wrapped one. A new raw `begin_write`, `begin_write_locked` or
    /// `begin_write_exclusive` fails here until it is reviewed and listed.
    #[test]
    fn every_store_write_handle_stays_wrapped_in_the_flagging_writer() {
        let sources = crate_sources();
        let code = |name: &str| &sources.iter().find(|(n, _)| n == name).unwrap().1;

        // Raw write handles, each reviewed:
        // - the kv backends and their trait: `kv.rs` (the trait and its three defaults),
        //   `redb_kv.rs` (the table create on first open, the writable backend's `begin_write`, and
        //   `RedbSink`'s three redb transactions on the new record file a store snapshot fills: no
        //   brain store has that file open, so no store write handle exists to flag),
        //   `fjall_kv.rs`, and
        //   `occ_kv.rs` (its trait methods, the deadline-bounded locked begin, the commit onto
        //   the base store, and two in its `sim` feature test module);
        // - `lib.rs`: the brain-create write, the three arms of `Store::write`'s unbound loop, and
        //   the format upgrade (no page records; the format-5 carry-over in `seed/format_5.rs` writes
        //   purge tombstones, generations and oauth clients on it);
        // - `transactions.rs`: a transaction's base handle, exclusive (serialized) or optimistic (plain,
        //   or queued for the keys an earlier run lost on); its statements run through the bound arm
        //   of `Store::write`. A
        //   serialized rollback writes its counters forward on that same handle; an optimistic one
        //   that did not commit raises them in one write of `raise_counter` operations only
        //   (`raise_forward`), which writes no page record;
        // - `transactions/optimistic_tests.rs` and `transactions/review_tests.rs`, whole files under
        //   `#[cfg(test)]` that hold retry keys directly on the store's `Kv`;
        // - this module's open-time scan, the keyword index
        //   repair (`keyword/index_build.rs`, postings only) and the open-time repair of the
        //   derivation sweep records' source index (`page_body/purge_record.rs`, index keys only);
        // - the keyword test modules (`index_build/tests.rs`, `index_writer/tests.rs`), which are
        //   whole files under `#[cfg(test)]`;
        // - `seed/v0_60_766_tests.rs`, a whole file under `#[cfg(test)]` that writes an older
        //   addon's records into an empty record file before any store opens it;
        // - `facts/entity_order_tests.rs`, a whole file under `#[cfg(test)]` whose commit-order test stamps rows
        //   straight on the `Kv` to read each commit's own commit sequence (fact rows are not written, so no
        //   page record can name readers);
        // - `test_support.rs`'s `FaultyKv`, which wraps a record store in tests to make a write
        //   transaction fail like a disk and passes every call on (4 calls and definitions);
        // - `leases_tests.rs`, a whole file under `#[cfg(test)]` whose read-set test opens raw write transactions on the
        //   concurrent store to show a lease read is checked again at commit (3 calls);
        // - `lib.rs`'s multi-user open, which records the clock floor once in its own write (no page record);
        // - `kv.rs`'s `Unserialized`, which wraps a record store to withhold
        //   `serialized_transactions` and passes every call on (6 calls and definitions beside the
        //   trait's 5).
        let allowed: &[(&str, usize)] = &[
            ("access_flag.rs", 1),
            ("facts/entity_order_tests.rs", 1),
            ("fjall_kv.rs", 1),
            ("keyword/index_build.rs", 1),
            ("keyword/index_build/tests.rs", 1),
            ("keyword/index_writer/tests.rs", 2),
            ("kv.rs", 13),
            ("leases_tests.rs", 3),
            ("lib.rs", 5),
            ("occ_kv.rs", 8),
            ("page_body/purge_record.rs", 1),
            ("redb_kv.rs", 7),
            ("seed/v0_60_766_tests.rs", 1),
            ("test_support.rs", 4),
            ("transactions.rs", 4),
            ("transactions/optimistic_tests.rs", 4),
            ("transactions/review_tests.rs", 1),
        ];
        let opens = |c: &str| {
            [
                "begin_write(",
                "begin_write_locked(",
                "begin_write_locked_until(",
                "begin_write_exclusive(",
            ]
            .iter()
            .map(|p| c.matches(p).count())
            .sum::<usize>()
        };
        let raw: Vec<(&str, usize)> = sources
            .iter()
            .map(|(n, c)| (n.as_str(), opens(c)))
            .filter(|(_, count)| *count > 0)
            .collect();
        assert_eq!(raw, allowed, "a raw write handle skips the flagging writer");

        // Both arms of `Store::write` hand the closure to `write_chain`, which wraps it.
        let lib = code("lib.rs");
        // `write` and `write_as` both run through `write_under`, which owns the two arms.
        let write = &lib[lib.find("fn write_under<T>").unwrap()..];
        let write = &write[..write.find("\n    }\n").unwrap()];
        assert_eq!(write.matches("write_chain(").count(), 2);
        let chain = &lib[lib.find("fn write_chain<T>").unwrap()..];
        let chain = &chain[..chain.find("\n}\n").unwrap()];
        assert!(chain.contains("access_flag::FlaggingWriter(inner)"));

        // `bump_page_retrievals` writes with `Store::write`, never a raw handle.
        let ops = code("page_ops/retrievals.rs");
        let bump = &ops[ops.find("pub fn bump_page_retrievals").unwrap()..];
        let bump = &bump[..bump.find("\n    }\n").unwrap()];
        assert!(
            bump.contains("self.write(|tx|"),
            "bump_page_retrievals left Store::write"
        );
        assert!(!bump.contains("begin_write"));

        // The cascade takes the caller's handle; it opens none of its own.
        assert!(code("cascade.rs").contains("crate::page_ops::remove_page_rows(tx, page)?"));
        assert!(code("page_ops.rs").contains("pub(crate) use retrievals::remove_page_rows;"));
    }

    // With concurrent writers on (`OpenOptions::concurrent_writes`, `OccKv`), `Store::write` runs
    // `f` again after a conflict; every run writes through the flagging handle.

    fn concurrent(name: &str) -> (std::sync::Arc<Store>, std::path::PathBuf) {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/test-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let options = crate::OpenOptions {
            concurrent_writes: true,
            ..crate::OpenOptions::default()
        };
        let store = Store::open_dir(&dir.join("brain"), options).unwrap();
        (std::sync::Arc::new(store), dir)
    }

    #[test]
    fn with_concurrent_writes_a_reader_page_put_sets_the_flag_in_its_commit() {
        let (store, dir) = concurrent("access-flag-occ");
        put_open_page(&store, "notes/closed");
        assert_eq!(store.get_config(FLAG).unwrap(), None);
        name_readers_raw(&store, "notes/closed");
        assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_concurrent_writes_a_reader_page_put_that_reruns_after_a_conflict_sets_the_flag() {
        use std::sync::mpsc::channel;
        let (store, dir) = concurrent("access-flag-occ-rerun");
        put_open_page(&store, "notes/closed");
        let (inside_tx, inside) = channel();
        let (release_tx, release) = channel::<()>();
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let a = {
            let (store, runs) = (store.clone(), runs.clone());
            std::thread::spawn(move || {
                store
                    .write(|tx| {
                        let key = keys::page("default", "notes/closed");
                        let mut record: Value = serde_json::from_slice(&tx.get(&key)?.unwrap())?;
                        record["frontmatter"]["readable_by"] = json!(["alice-example"]);
                        tx.put(&key, &serde_json::to_vec(&record)?)?;
                        if runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                            let _ = inside_tx.send(());
                            let _ = release.recv_timeout(std::time::Duration::from_secs(30));
                        }
                        Ok(())
                    })
                    .unwrap()
            })
        };
        inside.recv().unwrap();
        // A read the page record; this commit changes it, so A's first run loses and runs again.
        put_open_page(&store, "notes/closed");
        release_tx.send(()).unwrap();
        a.join().unwrap();
        assert!(
            runs.load(std::sync::atomic::Ordering::SeqCst) >= 2,
            "A did not run again"
        );
        assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_concurrent_writes_parallel_reader_page_puts_all_land_and_set_the_flag() {
        let (store, dir) = concurrent("access-flag-occ-parallel");
        for n in 0..8 {
            put_open_page(&store, &format!("notes/p{n}"));
        }
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let store = store.clone();
                std::thread::spawn(move || name_readers_raw(&store, &format!("notes/p{n}")))
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
        for n in 0..8 {
            let page =
                crate::pages::read_page(&*store.read().unwrap(), "default", &format!("notes/p{n}"))
                    .unwrap()
                    .unwrap();
            assert!(page.frontmatter.contains_key("readable_by"));
        }
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An inner write handle that records which method it was called through, so a test can
    /// tell a forwarded call from the trait default (which reads and puts instead).
    #[derive(Default)]
    struct Recording(Vec<&'static str>);

    impl crate::kv::KvRead for Recording {
        fn get(&self, _key: &[u8]) -> crate::error::Result<Option<Vec<u8>>> {
            Ok(None)
        }

        fn scan(
            &self,
            _start: &[u8],
            _end: &[u8],
            _reverse: bool,
            _f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
        ) -> crate::error::Result<()> {
            Ok(())
        }
    }

    impl crate::kv::KvWrite for Recording {
        fn put(&mut self, _key: &[u8], _value: &[u8]) -> crate::error::Result<()> {
            self.0.push("put");
            Ok(())
        }

        fn delete(&mut self, _key: &[u8]) -> crate::error::Result<()> {
            self.0.push("delete");
            Ok(())
        }

        fn commit(self: Box<Self>) -> crate::error::Result<u64> {
            Ok(0)
        }

        fn allocate(&mut self, _key: &[u8], _count: u64) -> crate::error::Result<u64> {
            self.0.push("allocate");
            Ok(41)
        }

        fn raise_counter(&mut self, _key: &[u8], _value: u64) -> crate::error::Result<()> {
            self.0.push("raise_counter");
            Ok(())
        }

        fn add_i64(&mut self, _key: &[u8], _delta: i64) -> crate::error::Result<()> {
            self.0.push("add_i64");
            Ok(())
        }

        fn counter_below(&mut self, _key: &[u8], _cap: i64) -> crate::error::Result<Option<i64>> {
            self.0.push("counter_below");
            Ok(Some(7))
        }
    }

    /// The four counter calls reach the inner handle's own method, not the trait default: a
    /// concurrent store (`occ_kv`) overrides them to add and raise without reading, so a wrapper
    /// that falls back to get-then-put turns every counter bump into a read conflict.
    #[test]
    fn counter_calls_pass_through_to_the_inner_handle() {
        use crate::kv::KvWrite;
        let mut inner = Recording::default();
        let mut writer = super::FlaggingWriter(&mut inner);
        assert_eq!(writer.allocate(b"seq", 3).unwrap(), 41);
        writer.raise_counter(b"seq", 9).unwrap();
        writer.add_i64(b"n", 2).unwrap();
        assert_eq!(writer.counter_below(b"n", 5).unwrap(), Some(7));
        assert_eq!(
            inner.0,
            ["allocate", "raise_counter", "add_i64", "counter_below"]
        );
    }
}
