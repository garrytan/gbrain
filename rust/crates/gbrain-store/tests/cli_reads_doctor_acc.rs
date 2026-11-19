//! The request-log doctor reads (`cli_reads/doctor_acc.rs`): the PGLite semantics of each.

use gbrain_store::env::{iso, uuid_from_bytes};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::telemetry::McpRequestLogInput;
use gbrain_store::{Env, OpenOptions, Store};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);
const NOW: i64 = 1_800_000_000_000_000;
const DAY_US: i64 = 86_400_000_000;

struct Clock(AtomicU64);

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        NOW
    }
    fn new_uuid(&self) -> String {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

fn brain(name: &str) -> Store {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "doctor-acc-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    Store::open_kv(
        kv,
        Arc::new(Clock(AtomicU64::new(1))),
        OpenOptions::default(),
    )
    .unwrap()
}

fn log(s: &Store, op: &str, age_days: i64) {
    s.log_mcp_request(&McpRequestLogInput {
        token_name: Some("t".to_string()),
        operation: Some(op.to_string()),
        status: Some("success".to_string()),
        created_at: Some(iso(NOW - age_days * DAY_US)),
        ..McpRequestLogInput::default()
    })
    .unwrap();
}

#[test]
fn an_empty_log_is_zero_bytes_and_zero_rows() {
    let s = brain("empty");
    assert_eq!(s.read_mcp_request_log_bytes().unwrap(), 0);
    assert_eq!(s.count_mcp_request_log_rows(100.0).unwrap(), 0);
    assert!(!s.has_mcp_log_rows_past_window(90.0, &[]).unwrap());
}

#[test]
fn rows_are_counted_up_to_the_limit_and_bytes_grow_with_them() {
    let s = brain("count");
    log(&s, "get_page", 1);
    let one = s.read_mcp_request_log_bytes().unwrap();
    assert!(one > 0);
    log(&s, "get_page", 2);
    log(&s, "get_page", 3);
    assert!(s.read_mcp_request_log_bytes().unwrap() > one);
    assert_eq!(s.count_mcp_request_log_rows(100.0).unwrap(), 3);
    assert_eq!(s.count_mcp_request_log_rows(2.0).unwrap(), 2);
    assert_eq!(s.count_mcp_request_log_rows(0.0).unwrap(), 0);
}

#[test]
fn a_row_past_the_window_waits_unless_its_operation_is_kept() {
    let s = brain("window");
    log(&s, "get_page", 10);
    assert!(!s.has_mcp_log_rows_past_window(90.0, &[]).unwrap());
    log(&s, "audit_op", 200);
    let keep = vec!["audit_op".to_string()];
    assert!(s.has_mcp_log_rows_past_window(90.0, &[]).unwrap());
    assert!(!s.has_mcp_log_rows_past_window(90.0, &keep).unwrap());
    log(&s, "get_page", 100);
    assert!(s.has_mcp_log_rows_past_window(90.0, &keep).unwrap());
    // The window is a whole number of days, as the SQL casts it to int4.
    let err = s.has_mcp_log_rows_past_window(f64::NAN, &[]).unwrap_err();
    assert!(!err.to_string().is_empty());
}
