//! Persistence consumer heartbeat rows for a Rust brain in multi-user mode (audit row B8 of
//! `docs/designs/rust-engine/multi-user-server.md`; the SQL engines' `persistence_consumers` table and its four
//! statements in `src/core/engine-sql/persistence-claims.ts`).
//!
//! One process owned a Rust brain until now, so the store kept no consumer rows and the TypeScript members answered
//! none. With clients on several hosts, consumer election needs the rows: one row per consumer process
//! `(host_id, pid, nonce)`, renewed by its heartbeat, read on the store's clock (one server, one clock), so two hosts'
//! clocks never enter liveness. The members mirror the SQL statements:
//!
//! - `list_host_consumer_rows(host)`: every row of the host, oldest first (`started_at`, then `pid`);
//! - `probe_live_consumer_rows(probe)`: the host's live full or promoted rows of the given kinds other than the caller,
//!   renewed within `live_ms` and not `restart_required`, oldest first;
//! - `renew_consumer_row(renewal)`: purges the host's rows renewed more than `purge_ms` ago (not the caller's), then
//!   inserts the caller's row or renews it (`renewed_at`, `mode`, `restart_required`, `root_barrier_age_ms`, `pool`,
//!   `version`, `segment_reader`, `capabilities`, as `ON CONFLICT DO UPDATE` sets them);
//! - `delete_consumer_row(key)`.
//!
//! Each row read has the SQL shape: times as `timestamptz::text`, `renewed_age_ms` and `age_ms` as text milliseconds.
//! Keys: `~L 0x02 <host_id> 0x00 <pid as 8 hex digits> 0x00 <nonce>` (`leases.rs`, sub-tag `CONSUMER_ROW`). Nothing is
//! written here unless a member is called, and the TypeScript members call them only on a store in multi-user mode.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::leases::CONSUMER_ROW;
use crate::{get_json, put_json};

/// What this binary's consumer can drain (`CONSUMER_CAPABILITIES`).
const CAPABILITIES: [&str; 2] = ["refresh_barrier_1", "refresh_barrier_import_1"];

/// `ConsumerRenewal`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerRenewal {
    pub host_id: String,
    pub pid: i32,
    pub nonce: String,
    pub pid_ns: Option<String>,
    pub kind: String,
    pub mode: String,
    pub restart_required: bool,
    pub root_barrier_age_ms: Option<i64>,
    /// JSON text or null.
    pub pool: Option<String>,
    pub host_json_path: String,
    pub persistence_home: String,
    /// JSON text or null.
    pub minted_under: Option<String>,
    pub version: String,
    pub purge_ms: i64,
    #[serde(default)]
    pub boot_id: Option<String>,
    #[serde(default)]
    pub process_start: Option<String>,
}

/// `ConsumerProbe`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerProbe {
    pub host_id: String,
    pub kinds: Vec<String>,
    pub pid: i32,
    pub nonce: String,
    pub live_ms: i64,
}

/// `ConsumerRowKey`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerRowKey {
    pub host_id: String,
    pub pid: i32,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConsumerRecord {
    host_id: String,
    pid: i32,
    nonce: String,
    pid_ns: Option<String>,
    kind: String,
    mode: String,
    started_at_us: i64,
    renewed_at_us: i64,
    restart_required: bool,
    root_barrier_age_ms: Option<i64>,
    pool: Value,
    host_json_path: String,
    persistence_home: String,
    minted_under: Value,
    version: String,
    boot_id: Option<String>,
    process_start: Option<String>,
    segment_reader: bool,
    capabilities: Vec<String>,
}

fn check_text(what: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.contains('\0') {
        return Err(StoreError::invalid(format!(
            "consumer {what} must be non-empty text without NUL"
        )));
    }
    Ok(())
}

fn host_prefix(host_id: &str) -> Vec<u8> {
    let mut key = keys::LEASES.to_vec();
    key.push(CONSUMER_ROW);
    key.extend_from_slice(host_id.as_bytes());
    key.push(0);
    key
}

fn row_key(host_id: &str, pid: i32, nonce: &str) -> Vec<u8> {
    let mut key = host_prefix(host_id);
    key.extend_from_slice(format!("{:08x}", pid as u32).as_bytes());
    key.push(0);
    key.extend_from_slice(nonce.as_bytes());
    key
}

fn json_text(text: &Option<String>, what: &str) -> Result<Value> {
    match text {
        None => Ok(Value::Null),
        Some(t) => serde_json::from_str(t)
            .map_err(|e| StoreError::invalid(format!("consumer {what} is not JSON: {e}"))),
    }
}

fn host_rows(read: &dyn KvRead, host_id: &str) -> Result<Vec<ConsumerRecord>> {
    let mut raw: Vec<Vec<u8>> = Vec::new();
    scan_prefix(read, &host_prefix(host_id), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    let mut rows = Vec::with_capacity(raw.len());
    for bytes in raw {
        rows.push(serde_json::from_slice::<ConsumerRecord>(&bytes)?);
    }
    rows.sort_by(|a, b| {
        a.started_at_us
            .cmp(&b.started_at_us)
            .then(a.pid.cmp(&b.pid))
    });
    Ok(rows)
}

/// Milliseconds between two instants as Postgres `(EXTRACT(EPOCH FROM interval)*1000)::bigint::text` gives them
/// (rounded to the nearest millisecond, halves away from zero).
fn age_ms_text(now_us: i64, then_us: i64) -> String {
    let micros = now_us - then_us;
    let ms = (micros as f64 / 1000.0).round() as i64;
    ms.to_string()
}

fn row_value(r: &ConsumerRecord, now: i64) -> Value {
    json!({
        "host_id": r.host_id, "pid": r.pid, "nonce": r.nonce, "pid_ns": r.pid_ns, "kind": r.kind, "mode": r.mode,
        "started_at": crate::telemetry::pg_timestamptz_text(r.started_at_us),
        "renewed_at": crate::telemetry::pg_timestamptz_text(r.renewed_at_us),
        "restart_required": r.restart_required, "root_barrier_age_ms": r.root_barrier_age_ms, "pool": r.pool,
        "host_json_path": r.host_json_path, "persistence_home": r.persistence_home, "minted_under": r.minted_under,
        "version": r.version, "boot_id": r.boot_id, "process_start": r.process_start,
        "renewed_age_ms": age_ms_text(now, r.renewed_at_us), "age_ms": age_ms_text(now, r.started_at_us),
    })
}

impl Store {
    /// `listHostConsumerRows(hostId)`: every consumer row of the host, oldest first, ages on the store clock.
    pub fn list_host_consumer_rows(&self, host_id: &str) -> Result<Vec<Value>> {
        check_text("host_id", host_id)?;
        let now = self.env.clock_micros();
        Ok(host_rows(&*self.read()?, host_id)?
            .iter()
            .map(|r| row_value(r, now))
            .collect())
    }

    /// `probeLiveConsumerRows(probe)`: the host's live full or promoted consumers of the given kinds other than the
    /// caller, renewed within `live_ms` and not asking for a restart, oldest first.
    pub fn probe_live_consumer_rows(&self, probe: &ConsumerProbe) -> Result<Vec<Value>> {
        check_text("host_id", &probe.host_id)?;
        let now = self.env.clock_micros();
        let floor = now - probe.live_ms.saturating_mul(1000);
        Ok(host_rows(&*self.read()?, &probe.host_id)?
            .iter()
            .filter(|r| {
                matches!(r.mode.as_str(), "full" | "promoted")
                    && probe.kinds.contains(&r.kind)
                    && !(r.pid == probe.pid && r.nonce == probe.nonce)
                    && r.renewed_at_us > floor
                    && !r.restart_required
            })
            .map(|r| row_value(r, now))
            .collect())
    }

    /// `renewConsumerRow(renewal)`: purges the host's lapsed rows other than the caller's, then inserts or renews the
    /// caller's row, in one write.
    pub fn renew_consumer_row(&self, r: &ConsumerRenewal) -> Result<()> {
        check_text("host_id", &r.host_id)?;
        check_text("nonce", &r.nonce)?;
        let pool = json_text(&r.pool, "pool")?;
        let minted_under = json_text(&r.minted_under, "minted_under")?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let purge_floor = now - r.purge_ms.saturating_mul(1000);
            for old in host_rows(tx, &r.host_id)? {
                if old.renewed_at_us < purge_floor && !(old.pid == r.pid && old.nonce == r.nonce) {
                    tx.delete(&row_key(&old.host_id, old.pid, &old.nonce))?;
                }
            }
            let key = row_key(&r.host_id, r.pid, &r.nonce);
            let row = match get_json::<ConsumerRecord>(tx, &key)? {
                Some(mut old) => {
                    old.renewed_at_us = now;
                    old.mode = r.mode.clone();
                    old.restart_required = r.restart_required;
                    old.root_barrier_age_ms = r.root_barrier_age_ms;
                    old.pool = pool.clone();
                    old.version = r.version.clone();
                    old.segment_reader = true;
                    old.capabilities = CAPABILITIES.iter().map(|c| c.to_string()).collect();
                    old
                }
                None => ConsumerRecord {
                    host_id: r.host_id.clone(),
                    pid: r.pid,
                    nonce: r.nonce.clone(),
                    pid_ns: r.pid_ns.clone(),
                    kind: r.kind.clone(),
                    mode: r.mode.clone(),
                    started_at_us: now,
                    renewed_at_us: now,
                    restart_required: r.restart_required,
                    root_barrier_age_ms: r.root_barrier_age_ms,
                    pool: pool.clone(),
                    host_json_path: r.host_json_path.clone(),
                    persistence_home: r.persistence_home.clone(),
                    minted_under: minted_under.clone(),
                    version: r.version.clone(),
                    boot_id: r.boot_id.clone(),
                    process_start: r.process_start.clone(),
                    segment_reader: true,
                    capabilities: CAPABILITIES.iter().map(|c| c.to_string()).collect(),
                },
            };
            put_json(tx, &key, &row)
        })
    }

    /// `deleteConsumerRow(key)`: deletes the caller's row (a missing row changes nothing).
    pub fn delete_consumer_row(&self, key: &ConsumerRowKey) -> Result<()> {
        check_text("host_id", &key.host_id)?;
        let row = row_key(&key.host_id, key.pid, &key.nonce);
        self.write(|tx| {
            if tx.get(&row)?.is_some() {
                tx.delete(&row)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;
    use crate::test_support::{mem_kv, occ_kv};
    use crate::{OpenOptions, Store};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct Clock(AtomicI64);
    impl Env for Clock {
        fn now_micros(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
        fn new_uuid(&self) -> String {
            "00000000-0000-4000-8000-000000000001".into()
        }
    }

    fn renewal(host: &str, pid: i32, nonce: &str, mode: &str) -> ConsumerRenewal {
        ConsumerRenewal {
            host_id: host.into(),
            pid,
            nonce: nonce.into(),
            pid_ns: None,
            kind: "serve".into(),
            mode: mode.into(),
            restart_required: false,
            root_barrier_age_ms: None,
            pool: Some("{\"max\":4}".into()),
            host_json_path: "/h/host.json".into(),
            persistence_home: "/h".into(),
            minted_under: None,
            version: "0.0.0".into(),
            purge_ms: 120_000,
            boot_id: None,
            process_start: None,
        }
    }

    #[test]
    fn rows_renew_list_probe_purge_and_delete_on_the_store_clock() {
        for (mode, kv) in [
            ("single", mem_kv()),
            ("concurrent", Arc::new(occ_kv()) as Arc<dyn crate::kv::Kv>),
        ] {
            let clock = Arc::new(Clock(AtomicI64::new(1_800_000_000_000_000)));
            let store = Store::open_kv(
                kv,
                clock.clone(),
                OpenOptions {
                    multiuser: true,
                    ..OpenOptions::default()
                },
            )
            .unwrap();
            store
                .renew_consumer_row(&renewal("h1", 10, "a", "full"))
                .unwrap();
            clock.0.fetch_add(1_000_000, Ordering::SeqCst);
            store
                .renew_consumer_row(&renewal("h1", 11, "b", "waiter"))
                .unwrap();
            store
                .renew_consumer_row(&renewal("h2", 10, "c", "full"))
                .unwrap();
            let rows = store.list_host_consumer_rows("h1").unwrap();
            assert_eq!(
                rows.iter()
                    .map(|r| r["nonce"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["a", "b"],
                "{mode}"
            );
            assert_eq!(rows[0]["renewed_age_ms"], "1000", "{mode}");
            assert_eq!(rows[0]["pool"], json!({ "max": 4 }), "{mode}");
            assert_eq!(rows[0]["started_at"], "2027-01-15 08:00:00+00", "{mode}");
            // The probe sees host h1's live full consumer, not the caller and not other hosts.
            let probe = |pid, nonce: &str| ConsumerProbe {
                host_id: "h1".into(),
                kinds: vec!["serve".into()],
                pid,
                nonce: nonce.into(),
                live_ms: 30_000,
            };
            let live = store.probe_live_consumer_rows(&probe(11, "b")).unwrap();
            assert_eq!(live.len(), 1, "{mode}");
            assert_eq!(live[0]["nonce"], "a");
            assert!(
                store
                    .probe_live_consumer_rows(&probe(10, "a"))
                    .unwrap()
                    .is_empty(),
                "{mode}: a waiter is not a full consumer"
            );
            // Past the live window the row is not live; past the purge window another renewal on the host purges it.
            clock.0.fetch_add(60_000_000, Ordering::SeqCst);
            assert!(
                store
                    .probe_live_consumer_rows(&probe(11, "b"))
                    .unwrap()
                    .is_empty(),
                "{mode}"
            );
            clock.0.fetch_add(120_000_000, Ordering::SeqCst);
            store
                .renew_consumer_row(&renewal("h1", 11, "b", "full"))
                .unwrap();
            let rows = store.list_host_consumer_rows("h1").unwrap();
            assert_eq!(rows.len(), 1, "{mode}");
            assert_eq!(rows[0]["mode"], "full");
            store
                .delete_consumer_row(&ConsumerRowKey {
                    host_id: "h1".into(),
                    pid: 11,
                    nonce: "b".into(),
                })
                .unwrap();
            assert!(
                store.list_host_consumer_rows("h1").unwrap().is_empty(),
                "{mode}"
            );
            assert_eq!(
                store.list_host_consumer_rows("h2").unwrap().len(),
                1,
                "{mode}"
            );
        }
    }
}
