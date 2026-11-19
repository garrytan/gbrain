//! The doctor checkpoint reads served from the store (`cli_reads/doctor_checkpoints.rs`): the PGLite
//! semantics of each.

use gbrain_store::cli_reads::doctor_checkpoints::LastKnownWrite;
use gbrain_store::env::uuid_from_bytes;
use gbrain_store::kv::Kv;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::stats::IngestInput;
use gbrain_store::{Env, OpenOptions, Store};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);
const START: i64 = 1_800_000_000_000_000;
const HOUR: i64 = 3_600_000_000;

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

fn brain(name: &str) -> (Store, Arc<Clock>) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "doctor-ckp-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv: Arc<dyn Kv> = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let clock = Arc::new(Clock {
        now: AtomicI64::new(START),
        ids: AtomicU64::new(1),
    });
    let store = Store::open_kv(kv, clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn ingest(s: &Store, source_id: &str, source_type: &str, summary: &str) {
    let input: IngestInput = serde_json::from_value(json!({
        "source_id": source_id,
        "source_type": source_type,
        "source_ref": "ref",
        "pages_updated_json": "[]",
        "summary": summary,
    }))
    .unwrap();
    s.log_ingest(&input).unwrap();
}

fn last_known(op: &str, rows: Value) -> LastKnownWrite {
    serde_json::from_value(json!({ "op": op, "rows": rows })).unwrap()
}

#[test]
fn last_known_reads_back_what_was_written_and_an_upsert_replaces_it() {
    let (s, _) = brain("last-known");
    assert_eq!(
        s.read_doctor_last_known("doctor-last-known").unwrap(),
        Vec::<Value>::new()
    );
    s.write_doctor_last_known(&last_known(
        "doctor-last-known",
        json!([
            { "entry": "connectors", "value": { "checks": [], "measured_at": "2026-11-19T00:00:00.000Z", "elapsed_ms": 4 } },
            { "entry": "queue", "value": { "measured_at": "t1", "checks": [{ "name": "queue", "status": "ok" }] } },
        ]),
    ))
    .unwrap();
    s.write_doctor_last_known(&last_known(
        "other-op",
        json!([{ "entry": "queue", "value": { "other": true } }]),
    ))
    .unwrap();
    let mut rows = s.read_doctor_last_known("doctor-last-known").unwrap();
    rows.sort_by_key(|r| r["fingerprint"].as_str().unwrap().to_string());
    assert_eq!(
        Value::Array(rows),
        json!([
            { "fingerprint": "connectors", "entry": { "checks": [], "elapsed_ms": 4, "measured_at": "2026-11-19T00:00:00.000Z" } },
            { "fingerprint": "queue", "entry": { "checks": [{ "name": "queue", "status": "ok" }], "measured_at": "t1" } },
        ])
    );
    s.write_doctor_last_known(&last_known(
        "doctor-last-known",
        json!([{ "entry": "queue", "value": { "measured_at": "t2", "checks": [] } }]),
    ))
    .unwrap();
    let rows = s.read_doctor_last_known("doctor-last-known").unwrap();
    let queue = rows.iter().find(|r| r["fingerprint"] == "queue").unwrap();
    assert_eq!(queue["entry"]["measured_at"], "t2");
    assert_eq!(rows.len(), 2);
    // A prefix of another op's name is not that op.
    assert!(s.read_doctor_last_known("doctor").unwrap().is_empty());
}

#[test]
fn the_latest_connector_receipt_is_the_newest_connector_row_whatever_follows_it() {
    let (s, clock) = brain("connector");
    assert_eq!(s.read_latest_connector_receipt().unwrap(), Value::Null);
    ingest(&s, "default", "connector", "synced 3");
    clock.now.store(START + 1, Ordering::SeqCst);
    ingest(&s, "default", "connector", "synced 4 DRIFT: 2 skipped");
    clock.now.store(START + 2, Ordering::SeqCst);
    ingest(&s, "default", "markdown", "imported");
    assert_eq!(
        s.read_latest_connector_receipt().unwrap(),
        json!("synced 4 DRIFT: 2 skipped")
    );
    // Equal times fall to the larger id.
    ingest(&s, "default", "connector", "same tick, first id");
    ingest(&s, "default", "connector", "same tick, later id");
    assert_eq!(
        s.read_latest_connector_receipt().unwrap(),
        json!("same tick, later id")
    );
}

#[test]
fn facts_absorb_groups_cover_the_last_24_hours_by_source_and_reason() {
    let (s, clock) = brain("facts");
    assert!(s.list_facts_absorb_failure_groups().unwrap().is_empty());
    // Older than the window: not counted.
    ingest(&s, "default", "facts:absorb", "old_failure: x");
    clock.now.store(START + 10 * HOUR, Ordering::SeqCst);
    ingest(&s, "work", "facts:absorb", "timeout: a");
    ingest(&s, "default", "facts:absorb", "timeout: b");
    ingest(&s, "default", "facts:absorb", "timeout: c");
    ingest(&s, "default", "facts:absorb", "parse_error");
    ingest(&s, "default", "markdown", "timeout: not an absorb row");
    clock.now.store(START + 11 * HOUR, Ordering::SeqCst);
    ingest(&s, "default", "facts:absorb", "parse_error: again");
    clock.now.store(START + 30 * HOUR, Ordering::SeqCst);
    let rows = s.list_facts_absorb_failure_groups().unwrap();
    let text: Vec<(&str, &str, &str, &str)> = rows
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap(),
                r["reason"].as_str().unwrap(),
                r["n"].as_str().unwrap(),
                r["newest"].as_str().unwrap(),
            )
        })
        .collect();
    // Source in byte order, then the larger count first, equal counts by reason; `newest` is the
    // latest row of the group (START is 2027-01-15T08:00Z).
    assert_eq!(
        text,
        vec![
            ("default", "parse_error", "2", "2027-01-15T19:00:00.000000Z"),
            ("default", "timeout", "2", "2027-01-15T18:00:00.000000Z"),
            ("work", "timeout", "1", "2027-01-15T18:00:00.000000Z"),
        ]
    );
}
