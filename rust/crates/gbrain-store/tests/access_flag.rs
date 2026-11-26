//! The sticky member-access flag: a page write whose frontmatter has a top-level `readable_by`
//! key sets config `access.restrictions_present` to `'1'`, as PGLite's trigger
//! `pages_access_mark_restricted` does; a page without it leaves the flag unset.

mod common;

use common::{TempDir, open};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Kv, OpenOptions, Store, SystemEnv, keys};
use serde_json::{Value, json};
use std::sync::Arc;

const FLAG: &str = "access.restrictions_present";

fn put(store: &Store, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

#[test]
fn a_page_without_readable_by_leaves_the_flag_unset() {
    let dir = TempDir::new("access-flag");
    let store = open(&dir);
    put(
        &store,
        "notes/open",
        json!({"tags": ["a"], "meta": {"readable_by": ["x"]}}),
    );
    assert_eq!(store.get_config(FLAG).unwrap(), None);
}

#[test]
fn a_page_with_readable_by_sets_the_flag_and_it_stays_set() {
    let dir = TempDir::new("access-flag");
    let store = open(&dir);
    put(
        &store,
        "notes/closed",
        json!({"readable_by": ["alice-example"]}),
    );
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
    put(&store, "notes/closed", json!({}));
    store
        .soft_delete_page("notes/closed", Some("default"))
        .unwrap();
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
}

#[test]
fn a_flag_set_to_another_value_is_set_to_one() {
    let dir = TempDir::new("access-flag");
    let store = open(&dir);
    store.set_config(FLAG, "0").unwrap();
    put(
        &store,
        "notes/closed",
        json!({"readable_by": "group:team-a"}),
    );
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
}

// The open-time scan. A brain written by a build before the page write hook set the flag (or by
// any path that skipped the hook) holds a `readable_by` page and no flag. Opening it sets the flag
// once, as schema migration v282 sets it once from the pages already in the table.

/// The meta record the open-time scan leaves behind (`access_flag::SCAN_DONE`).
const SCAN_DONE: &str = "access_flag_scan";

fn raw_store(dir: &TempDir) -> (Arc<dyn Kv>, Store) {
    let kv: Arc<dyn Kv> = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    (kv, store)
}

fn reopen(kv: &Arc<dyn Kv>) -> Store {
    Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap()
}

/// Drops the flag and the scan record with a raw write: the state a brain written before the hook
/// existed is in.
fn forget_flag(kv: &Arc<dyn Kv>) {
    let mut tx = kv.begin_write().unwrap();
    tx.delete(&keys::text(keys::CONFIG, &[FLAG])).unwrap();
    tx.delete(&keys::meta(SCAN_DONE)).unwrap();
    tx.commit().unwrap();
}

#[test]
fn opening_a_brain_with_an_unflagged_reader_page_sets_the_flag() {
    let dir = TempDir::new("access-flag-open");
    let (kv, store) = raw_store(&dir);
    put(&store, "notes/open", json!({"tags": ["a"]}));
    put(
        &store,
        "notes/closed",
        json!({"readable_by": ["alice-example"]}),
    );
    drop(store);
    forget_flag(&kv);
    let store = reopen(&kv);
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
}

#[test]
fn a_soft_deleted_reader_page_counts_as_v282_counts_it() {
    let dir = TempDir::new("access-flag-open");
    let (kv, store) = raw_store(&dir);
    put(
        &store,
        "notes/closed",
        json!({"readable_by": "group:team-a"}),
    );
    store
        .soft_delete_page("notes/closed", Some("default"))
        .unwrap();
    drop(store);
    forget_flag(&kv);
    let store = reopen(&kv);
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
}

#[test]
fn opening_a_brain_with_no_reader_page_leaves_the_flag_unset() {
    let dir = TempDir::new("access-flag-open");
    let (kv, store) = raw_store(&dir);
    put(
        &store,
        "notes/open",
        json!({"meta": {"readable_by": ["x"]}}),
    );
    drop(store);
    forget_flag(&kv);
    let store = reopen(&kv);
    assert_eq!(store.get_config(FLAG).unwrap(), None);
    drop(store);
    assert!(
        kv.snapshot()
            .unwrap()
            .get(&keys::meta(SCAN_DONE))
            .unwrap()
            .is_some()
    );
}

#[test]
fn the_scan_runs_once_so_a_flag_unset_by_hand_stays_unset() {
    let dir = TempDir::new("access-flag-open");
    let (kv, store) = raw_store(&dir);
    put(
        &store,
        "notes/closed",
        json!({"readable_by": ["alice-example"]}),
    );
    drop(store);
    forget_flag(&kv);
    let store = reopen(&kv);
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
    store.set_config(FLAG, "0").unwrap();
    drop(store);
    let store = reopen(&kv);
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("0"));
}

// An open whose scan cannot write: a record file that takes no write after it opens (a full disk,
// or a file that turned read-only under the process). The open goes on, and the process treats
// the brain as flagged when the scan found a reader page or could not finish its read.

/// Record access that reads `inner` and refuses every write, as a file that takes no writes does.
struct NoWrites(Arc<dyn Kv>);

impl Kv for NoWrites {
    fn snapshot(&self) -> gbrain_store::Result<Box<dyn gbrain_store::KvRead>> {
        self.0.snapshot()
    }
    fn versioned_snapshot(
        &self,
    ) -> gbrain_store::Result<(Box<dyn gbrain_store::KvRead + Send>, u64)> {
        self.0.versioned_snapshot()
    }
    fn begin_write(&self) -> gbrain_store::Result<Box<dyn gbrain_store::KvWrite>> {
        Err(gbrain_store::StoreError::io(
            "record store: the file takes no writes",
        ))
    }
    fn version(&self) -> gbrain_store::Result<u64> {
        self.0.version()
    }
}

fn open_without_writes(kv: &Arc<dyn Kv>) -> gbrain_store::Result<Store> {
    Store::open_kv(
        Arc::new(NoWrites(kv.clone())),
        Arc::new(SystemEnv),
        OpenOptions::default(),
    )
}

#[test]
fn an_open_whose_scan_cannot_write_treats_a_reader_brain_as_flagged() {
    let dir = TempDir::new("access-flag-nowrite");
    let (kv, store) = raw_store(&dir);
    put(
        &store,
        "notes/closed",
        json!({"readable_by": ["alice-example"]}),
    );
    drop(store);
    forget_flag(&kv);
    let store = open_without_writes(&kv).expect("the open failed when its scan could not write");
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
    let values = store.get_config_values(&[FLAG.to_string()]).unwrap();
    assert_eq!(
        serde_json::to_value(&values).unwrap(),
        json!([{"key": FLAG, "value": "1"}])
    );
    assert_eq!(
        store
            .get_all_config()
            .unwrap()
            .get(FLAG)
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        store.list_config_keys("access.").unwrap(),
        vec![FLAG.to_string()]
    );
    drop(store);
    // Nothing was written: the next open that can write runs the scan and stores the flag.
    assert!(
        kv.snapshot()
            .unwrap()
            .get(&keys::meta(SCAN_DONE))
            .unwrap()
            .is_none()
    );
    let store = reopen(&kv);
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
}

#[test]
fn an_open_whose_scan_cannot_write_leaves_a_brain_with_no_reader_page_unflagged() {
    let dir = TempDir::new("access-flag-nowrite");
    let (kv, store) = raw_store(&dir);
    put(&store, "notes/open", json!({"tags": ["a"]}));
    drop(store);
    forget_flag(&kv);
    let store = open_without_writes(&kv).expect("the open failed when its scan could not write");
    assert_eq!(store.get_config(FLAG).unwrap(), None);
}

#[test]
fn an_open_whose_scan_cannot_write_judges_the_short_policy_as_flagged() {
    let dir = TempDir::new("access-flag-nowrite-short");
    let (kv, store) = raw_store(&dir);
    put(
        &store,
        "notes/closed",
        json!({"readable_by": ["member:alice-example"]}),
    );
    let atom: PageInput = serde_json::from_value(json!({
        "type": "atom", "title": "atom", "compiled_truth": "body",
        "frontmatter": {"source_slug": "notes/closed"}
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page("atoms/from-closed", &atom, &opts).unwrap();
    drop(store);
    forget_flag(&kv);
    let store = open_without_writes(&kv).expect("the open failed when its scan could not write");
    // The short member-access form (a caller that read the flag unset): it trusts the store's flag
    // for the origin walk. This process reads the flag as '1', so the walk runs and the atom derived
    // from a page that names readers stays hidden, as a full-form read hides it.
    let short = PrivacyPolicy {
        open: true,
        ..Default::default()
    };
    let hidden = |slug: &str, policy: &PrivacyPolicy| {
        store
            .read_page_hidden_from_caller("default", slug, policy)
            .unwrap()
    };
    assert!(hidden("notes/closed", &short));
    assert!(
        hidden("atoms/from-closed", &short),
        "the short form skipped the origin walk on a brain whose flag this process assumes"
    );
    assert!(hidden("atoms/from-closed", &PrivacyPolicy::default()));
}
