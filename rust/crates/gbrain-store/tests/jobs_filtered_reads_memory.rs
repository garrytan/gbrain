//! The two filtered job reads (`listUnfinishedJobsByName`, `listRecentSourceCycleFailures`) stream the rows of a status
//! index: each row is read, tested and dropped, and only the matching projection is kept. This binary counts heap bytes
//! with a global allocator and reads a store whose unrelated rows carry large payloads; the peak a read adds must stay
//! far below the unrelated rows' total size (a read that loaded and sorted every row first, as `live_rows` does, adds
//! at least that total).

mod memory_env;

use gbrain_store::jobs::{AdmitSpec, ClaimSpec};
use memory_env::{Brain, brain};
use serde_json::{Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let now = CURRENT.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
        PEAK.fetch_max(now, Ordering::SeqCst);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        CURRENT.fetch_sub(layout.size(), Ordering::SeqCst);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size >= layout.size() {
            let now = CURRENT.fetch_add(new_size - layout.size(), Ordering::SeqCst) + new_size
                - layout.size();
            PEAK.fetch_max(now, Ordering::SeqCst);
        } else {
            CURRENT.fetch_sub(layout.size() - new_size, Ordering::SeqCst);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

const UNRELATED: usize = 300;
const PAYLOAD: usize = 60_000;
/// What a read may add on top of what was live before it: a few rows' worth, not the 18 MB of unrelated payloads.
const BUDGET: usize = 3_000_000;

fn insert(name: &str, data: Value) -> Value {
    json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": data,
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    })
}

fn add(b: &Brain, name: &str, data: Value) -> i64 {
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert(name, data), "maxSpawnDepth": 5 }))
            .unwrap();
    b.admit_job(&spec).unwrap().row["id"].as_i64().unwrap()
}

fn claim_spec(token: &str, name: &str) -> ClaimSpec {
    serde_json::from_value(json!({
        "lockToken": token, "lockDurationMs": 30000, "queue": "default", "names": [name],
        "suspectMark": "watchdog_suspect", "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    }))
    .unwrap()
}

/// The peak heap bytes `f` adds to what was live when it started.
fn peak_added<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = CURRENT.load(Ordering::SeqCst);
    PEAK.store(before, Ordering::SeqCst);
    let out = f();
    (out, PEAK.load(Ordering::SeqCst).saturating_sub(before))
}

#[test]
fn filtered_job_reads_do_not_retain_unrelated_rows() {
    let b = brain("filtered-reads-memory");
    let blob = json!({ "blob": "x".repeat(PAYLOAD) });
    let wanted_a = add(&b, "manual", json!({}));
    for _ in 0..UNRELATED {
        add(&b, "other", blob.clone());
    }
    let wanted_b = add(&b, "manual", json!({}));

    let names = vec!["manual".to_string()];
    let (rows, added) = peak_added(|| b.list_unfinished_jobs_by_name(&names).unwrap());
    let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![wanted_a, wanted_b]);
    assert!(
        added < BUDGET,
        "listUnfinishedJobsByName added {added} bytes at its peak over {UNRELATED} unrelated rows of {PAYLOAD} bytes (budget {BUDGET})"
    );

    // Dead rows of another job name carry the payloads; one source's cycle failures are the answer.
    for n in 0..UNRELATED {
        let token = format!("w:{n}");
        let id = add(&b, "work", blob.clone());
        let row = b
            .claim_next_job(&claim_spec(&token, "work"))
            .unwrap()
            .unwrap();
        assert_eq!(row["id"].as_i64(), Some(id));
        b.fail_job(id, &token, "boom", "dead", None, None)
            .unwrap()
            .unwrap();
    }
    let cycle = add(&b, "autopilot-cycle", json!({ "source_id": "a" }));
    let row = b
        .claim_next_job(&claim_spec("c:1", "autopilot-cycle"))
        .unwrap()
        .unwrap();
    assert_eq!(row["id"].as_i64(), Some(cycle));
    b.fail_job(cycle, "c:1", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    let (failures, added) = peak_added(|| {
        b.list_recent_source_cycle_failures("2000-01-01T00:00:00.000Z", None)
            .unwrap()
    });
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["source_id"], "a");
    assert_eq!(failures[0]["fail_count"], 1);
    assert!(
        added < BUDGET,
        "listRecentSourceCycleFailures added {added} bytes at its peak over {UNRELATED} unrelated dead rows (budget {BUDGET})"
    );
}
