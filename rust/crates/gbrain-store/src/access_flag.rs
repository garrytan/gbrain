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
//! The other trigger, `access_members_mark_restricted`, has its store half in
//! `access_members::insert_access_member`, in the same write as the member. See
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
const SCAN_DONE: &str = "access_flag_scan";

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

/// A store write handle that sets the flag on every put of a page record with a top-level
/// `readable_by` key, in the same write. `Store::write` hands every write closure one.
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
        self.0.put(key, value)?;
        if is_page_record(key) && record_names_readers(value) {
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
}
