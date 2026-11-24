//! The `page_purges` ledger (`facts/page_purges.rs`): the PGLite semantics of `listRecentPurgeRequests`.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::facts::purge_ledger::FactPurgeInsert;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{Env, OpenOptions, Store};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);
const START: i64 = 1_800_000_000_000_000;
const DAY: i64 = 86_400_000_000;

struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

fn brain() -> (Store, Arc<Clock>) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "page-purges-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let clock = Arc::new(Clock {
        now: AtomicI64::new(START),
        ids: AtomicU64::new(1),
    });
    let store = Store::open_kv(kv, clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn hashes(list: &[&str]) -> Vec<String> {
    list.iter().map(|h| (*h).to_owned()).collect()
}

#[test]
fn recent_purge_requests_are_the_distinct_ids_inside_the_window_up_to_the_cap() {
    let (s, clock) = brain();
    assert!(s.list_recent_purge_requests(30, 100).unwrap().is_empty());
    let input: SourceInput = serde_json::from_value(json!({ "id": "wiki" })).unwrap();
    s.upsert_source(&input).unwrap();
    let old = "00000000-0000-4000-8000-000000000001";
    let first = "00000000-0000-4000-8000-000000000002";
    let second = "00000000-0000-4000-8000-000000000003";
    s.record_page_purge("wiki", &hashes(&["h-old"]), "notes/old", Some(old))
        .unwrap();
    clock.now.store(START + 40 * DAY, Ordering::SeqCst);
    // One request purging a page saved under two hashes counts once; a purge with no request counts never.
    s.record_page_purge("wiki", &hashes(&["h1", "h2"]), "notes/a", Some(first))
        .unwrap();
    s.record_page_purge("ghost", &hashes(&["h3"]), "notes/b", Some(second))
        .unwrap_err();
    s.record_page_purge("wiki", &hashes(&["h3"]), "notes/b", Some(second))
        .unwrap();
    s.record_page_purge("wiki", &hashes(&["h4"]), "notes/c", None)
        .unwrap();
    assert_eq!(
        s.list_recent_purge_requests(30, 100).unwrap(),
        [first, second]
    );
    assert_eq!(s.list_recent_purge_requests(30, 1).unwrap(), [first]);
    assert_eq!(
        s.list_recent_purge_requests(50, 100).unwrap(),
        [old, first, second]
    );
    // Saving the same hash again replaces the row, so the older request id no longer counts.
    s.record_page_purge("wiki", &hashes(&["h-old"]), "notes/old", Some(second))
        .unwrap();
    assert_eq!(
        s.list_recent_purge_requests(50, 100).unwrap(),
        [first, second]
    );
}

#[test]
fn recent_purge_requests_include_the_fact_purge_ledger() {
    let (s, clock) = brain();
    let input: SourceInput = serde_json::from_value(json!({ "id": "wiki" })).unwrap();
    s.upsert_source(&input).unwrap();
    let old = "00000000-0000-4000-8000-000000000011";
    let page = "00000000-0000-4000-8000-000000000012";
    let fact = "00000000-0000-4000-8000-000000000013";
    let tombstone = |hash: &str, request: Option<&str>| -> FactPurgeInsert {
        serde_json::from_value(json!({
            "sourceId": "wiki", "visibility": "private", "subject": "alice-example",
            "factHash": hash, "requestId": request, "actor": null, "reason": null,
        }))
        .unwrap()
    };
    assert!(s.insert_fact_purge(&tombstone("f-old", Some(old))).unwrap());
    clock.now.store(START + 40 * DAY, Ordering::SeqCst);
    s.record_page_purge("wiki", &hashes(&["h1"]), "notes/a", Some(page))
        .unwrap();
    // The same request purging a page and a fact counts once; a tombstone with no request never counts.
    assert!(s.insert_fact_purge(&tombstone("f1", Some(fact))).unwrap());
    assert!(s.insert_fact_purge(&tombstone("f2", Some(page))).unwrap());
    assert!(s.insert_fact_purge(&tombstone("f3", None)).unwrap());
    assert_eq!(s.list_recent_purge_requests(30, 100).unwrap(), [page, fact]);
    assert_eq!(
        s.list_recent_purge_requests(50, 100).unwrap(),
        [old, page, fact]
    );
    assert_eq!(s.list_recent_purge_requests(50, 2).unwrap(), [old, page]);
}
