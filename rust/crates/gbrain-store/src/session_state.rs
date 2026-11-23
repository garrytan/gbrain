//! Session state: the `session_context_state` table of the PGLite engine, the session cursor and
//! checkpoint manifest of context_pack and delta (src/core/context/session-state.ts).
//!
//! Members: upsertSessionState, readSessionCursor, readDeltaSessionRow, readCheckpointManifestRow,
//! writeCheckpointManifest, ageOutSessionState, capSessionStatePerClient.
//!
//! Keys: `x source_id \0 client_id \0 session_id -> SessionRecord`, the table's primary key. No
//! part may hold a NUL byte (Postgres `text` refuses one too), so the split is exact.
//!
//! Time: `updated_at` is the store clock at the write (inside a transaction, the transaction's
//! clock, as Postgres `now()` is the transaction start). The LRU cap ranks rows with equal
//! `updated_at` by `session_id` bytes (see `cap_session_state_per_client`), so no write order is
//! stored.
//!
//! JSON columns are stored as given and read back in Postgres `jsonb` key order
//! (`crate::dream::jsonb`), which is what a PGLite read returns.

use crate::dream::jsonb;
use crate::dream::jsonb_check;
use crate::env::iso;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::KvWrite;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::persistence::parse_timestamptz;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// What is stored for one `(source_id, client_id, session_id)` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionRecord {
    standing_entities: Value,
    surfaced_slugs: Value,
    checkpoint_manifest: Value,
    last_wake_at_us: Option<i64>,
    facts_cursor_at_us: Option<i64>,
    facts_cursor_id: Option<i64>,
    degraded_wakes: i32,
    updated_at_us: i64,
}

impl SessionRecord {
    /// A row as the column defaults leave it (`'[]'::jsonb`, NULL times, a zero counter).
    fn empty() -> Self {
        SessionRecord {
            standing_entities: json!([]),
            surfaced_slugs: json!([]),
            checkpoint_manifest: json!([]),
            last_wake_at_us: None,
            facts_cursor_at_us: None,
            facts_cursor_id: None,
            degraded_wakes: 0,
            updated_at_us: 0,
        }
    }
}

/// `SessionStateWrite` (src/core/engine-sql/session-state.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateWrite {
    pub standing_entities: Value,
    pub surfaced_slugs: Value,
    #[serde(default)]
    pub last_wake_at: Option<String>,
    pub replace_standing: bool,
    pub replace_cursor_slug: bool,
    #[serde(default)]
    pub facts_cursor_at: Option<String>,
    #[serde(default)]
    pub facts_cursor_id: Option<f64>,
    pub degraded_wakes: String,
}

fn session_key(source_id: &str, client_id: &str, session_id: &str) -> Vec<u8> {
    keys::text(keys::SESSION_STATE, &[source_id, client_id, session_id])
}

fn check_key(op: &str, source_id: &str, client_id: &str, session_id: &str) -> Result<()> {
    no_nul(
        op,
        &[
            ("sourceId", source_id),
            ("clientId", client_id),
            ("sessionId", session_id),
        ],
    )
}

/// `<text>::timestamptz` for the forms the callers pass (`Date#toISOString`, microsecond ISO).
fn timestamp(op: &str, text: &str) -> Result<i64> {
    parse_timestamptz(text, op).map_err(|_| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: invalid input syntax for type timestamp with time zone: \"{text}\""),
        )
    })
}

/// A JavaScript number bound to a `bigint`: an integer in range, or refused.
fn bigint(op: &str, value: f64) -> Result<i64> {
    // 2^63 is exact in f64; every integral f64 below it converts exactly.
    if value.fract() != 0.0
        || !value.is_finite()
        || !(-9.223_372_036_854_776e18..9.223_372_036_854_776e18).contains(&value)
    {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: invalid input syntax for type bigint: \"{value}\""),
        ));
    }
    Ok(value as i64)
}

/// A whole number the caller passes as a `$1` text parameter (`String(n)`).
fn whole(op: &str, what: &str, value: f64) -> Result<i64> {
    if value.fract() != 0.0 || !value.is_finite() || value.abs() > 9.0e15 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: {what} must be a whole number, got {value}"),
        ));
    }
    Ok(value as i64)
}

/// Writes `record` with this write's time.
fn put_record(tx: &mut dyn KvWrite, key: &[u8], mut record: SessionRecord, now: i64) -> Result<()> {
    record.updated_at_us = now;
    put_json(tx, key, &record)
}

/// A stored row with its key.
type Row = (Vec<u8>, SessionRecord);

/// Every stored row with its key, in key order.
fn all_rows(read: &dyn KvRead) -> Result<Vec<Row>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::SESSION_STATE], false, &mut |k, v| {
        raw.push((k.to_vec(), v.to_vec()));
        true
    })?;
    raw.into_iter()
        .map(|(k, v)| Ok((k, serde_json::from_slice(&v)?)))
        .collect()
}

/// The `(source_id, client_id)` of a key: the bytes before the second NUL.
fn lane(key: &[u8]) -> &[u8] {
    let body = &key[1..];
    let mut nuls = body
        .iter()
        .enumerate()
        .filter(|(_, b)| **b == 0)
        .map(|(i, _)| i);
    let _ = nuls.next();
    match nuls.next() {
        Some(at) => &body[..at],
        None => body,
    }
}

impl Store {
    /// `upsertSessionState(sourceId, clientId, sessionId, write)`: inserts or updates the session
    /// cursor row in one statement and returns its `degraded_wakes`, as the Postgres upsert does.
    pub fn upsert_session_state(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
        write: &SessionStateWrite,
    ) -> Result<i32> {
        const OP: &str = "upsertSessionState";
        check_key(OP, source_id, client_id, session_id)?;
        jsonb_check(OP, "standing_entities", &write.standing_entities)?;
        jsonb_check(OP, "surfaced_slugs", &write.surfaced_slugs)?;
        let last_wake = write
            .last_wake_at
            .as_deref()
            .map(|t| timestamp(OP, t))
            .transpose()?;
        let facts_at = write
            .facts_cursor_at
            .as_deref()
            .map(|t| timestamp(OP, t))
            .transpose()?;
        let facts_id = write.facts_cursor_id.map(|v| bigint(OP, v)).transpose()?;
        let key = session_key(source_id, client_id, session_id);
        self.write(|tx| {
            let now = self.env.now_micros();
            let old: Option<SessionRecord> = get_json(&*tx, &key)?;
            let record = match old {
                None => SessionRecord {
                    standing_entities: write.standing_entities.clone(),
                    surfaced_slugs: write.surfaced_slugs.clone(),
                    last_wake_at_us: last_wake,
                    facts_cursor_at_us: facts_at,
                    facts_cursor_id: facts_id,
                    degraded_wakes: i32::from(write.degraded_wakes == "increment"),
                    ..SessionRecord::empty()
                },
                Some(old) => SessionRecord {
                    standing_entities: if write.replace_standing {
                        write.standing_entities.clone()
                    } else {
                        old.standing_entities
                    },
                    surfaced_slugs: if write.replace_cursor_slug {
                        write.surfaced_slugs.clone()
                    } else {
                        old.surfaced_slugs
                    },
                    last_wake_at_us: last_wake.or(old.last_wake_at_us),
                    facts_cursor_at_us: facts_at.or(old.facts_cursor_at_us),
                    facts_cursor_id: if facts_at.is_none() {
                        old.facts_cursor_id
                    } else {
                        facts_id
                    },
                    degraded_wakes: match write.degraded_wakes.as_str() {
                        "increment" => old.degraded_wakes.checked_add(1).ok_or_else(|| {
                            StoreError::new(INVALID_ARGUMENT, format!("{OP}: integer out of range"))
                        })?,
                        "reset" => 0,
                        _ => old.degraded_wakes,
                    },
                    checkpoint_manifest: old.checkpoint_manifest,
                    ..SessionRecord::empty()
                },
            };
            let degraded = record.degraded_wakes;
            put_record(tx, &key, record, now)?;
            Ok(degraded)
        })
    }

    /// `readSessionCursor(sourceId, clientId, sessionId)`: `{ standing_entities, surfaced_slugs,
    /// last_wake_at }` (the wake time as microsecond ISO text), or `None` when there is no row.
    pub fn read_session_cursor(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
    ) -> Result<Option<Value>> {
        check_key("readSessionCursor", source_id, client_id, session_id)?;
        let read = self.read()?;
        let record: Option<SessionRecord> =
            get_json(&*read, &session_key(source_id, client_id, session_id))?;
        Ok(record.map(|r| {
            json!({
                "standing_entities": jsonb(&r.standing_entities),
                "surfaced_slugs": jsonb(&r.surfaced_slugs),
                "last_wake_at": r.last_wake_at_us.map(iso),
            })
        }))
    }

    /// `readDeltaSessionRow(sourceId, clientId, sessionId)`: `{ surfaced_slugs, last_wake_at,
    /// facts_cursor_at, facts_cursor_id, degraded_wakes }`, or `None` when there is no row.
    pub fn read_delta_session_row(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
    ) -> Result<Option<Value>> {
        check_key("readDeltaSessionRow", source_id, client_id, session_id)?;
        let read = self.read()?;
        let record: Option<SessionRecord> =
            get_json(&*read, &session_key(source_id, client_id, session_id))?;
        Ok(record.map(|r| {
            json!({
                "surfaced_slugs": jsonb(&r.surfaced_slugs),
                "last_wake_at": r.last_wake_at_us.map(iso),
                "facts_cursor_at": r.facts_cursor_at_us.map(iso),
                "facts_cursor_id": r.facts_cursor_id,
                "degraded_wakes": r.degraded_wakes,
            })
        }))
    }

    /// `readCheckpointManifestRow(sourceId, clientId, sessionId)`: `{ checkpoint_manifest }`, or
    /// `None` when there is no row.
    pub fn read_checkpoint_manifest_row(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
    ) -> Result<Option<Value>> {
        check_key(
            "readCheckpointManifestRow",
            source_id,
            client_id,
            session_id,
        )?;
        let read = self.read()?;
        let record: Option<SessionRecord> =
            get_json(&*read, &session_key(source_id, client_id, session_id))?;
        Ok(record.map(|r| json!({ "checkpoint_manifest": jsonb(&r.checkpoint_manifest) })))
    }

    /// `writeCheckpointManifest(sourceId, clientId, sessionId, manifest)`: replaces the manifest
    /// (and `updated_at`), creating the row with column defaults when there is none.
    pub fn write_checkpoint_manifest(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
        manifest: &Value,
    ) -> Result<()> {
        const OP: &str = "writeCheckpointManifest";
        check_key(OP, source_id, client_id, session_id)?;
        jsonb_check(OP, "checkpoint_manifest", manifest)?;
        let key = session_key(source_id, client_id, session_id);
        self.write(|tx| {
            let now = self.env.now_micros();
            let old: Option<SessionRecord> = get_json(&*tx, &key)?;
            let mut record = old.unwrap_or_else(SessionRecord::empty);
            record.checkpoint_manifest = manifest.clone();
            put_record(tx, &key, record, now)
        })
    }

    /// `ageOutSessionState(olderThanDays)`: deletes every row with `updated_at < now - N days`. A
    /// day is 86,400 seconds here; Postgres adds calendar days in the session time zone, which
    /// differs only across a daylight-saving change in a zone that has one.
    pub fn age_out_session_state(&self, older_than_days: f64) -> Result<()> {
        const OP: &str = "ageOutSessionState";
        let days = whole(OP, "olderThanDays", older_than_days)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let cutoff = now.saturating_sub(days.saturating_mul(86_400_000_000));
            for (key, record) in all_rows(&*tx)? {
                if record.updated_at_us < cutoff {
                    tx.delete(&key)?;
                }
            }
            Ok(())
        })
    }

    /// `capSessionStatePerClient(maxRowsPerClient)`: keeps the newest `maxRowsPerClient` rows of
    /// each `(source_id, client_id)`. Postgres ranks rows with `row_number() OVER (PARTITION BY
    /// source_id, client_id ORDER BY updated_at DESC, session_id COLLATE "C")`, a total order, so
    /// rows with equal `updated_at` (written in one transaction) rank by `session_id` bytes. Within
    /// a lane the key bytes after the lane are the `session_id` bytes, so the key breaks the tie.
    pub fn cap_session_state_per_client(&self, max_rows_per_client: f64) -> Result<()> {
        const OP: &str = "capSessionStatePerClient";
        let cap = whole(OP, "maxRowsPerClient", max_rows_per_client)?;
        self.write(|tx| {
            let mut rows = all_rows(&*tx)?;
            rows.sort_by(|x: &Row, y: &Row| {
                lane(&x.0)
                    .cmp(lane(&y.0))
                    .then_with(|| y.1.updated_at_us.cmp(&x.1.updated_at_us))
                    .then_with(|| x.0.cmp(&y.0))
            });
            let mut current: Option<Vec<u8>> = None;
            let mut rank: i64 = 0;
            for (key, _) in &rows {
                if current.as_deref() != Some(lane(key)) {
                    current = Some(lane(key).to_vec());
                    rank = 0;
                }
                rank += 1;
                if rank > cap {
                    tx.delete(key)?;
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// A clock the test sets.
    struct Clock(AtomicI64);
    impl Env for Clock {
        fn now_micros(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
        fn new_uuid(&self) -> String {
            String::new()
        }
    }

    const T0: i64 = 1_790_000_000_000_000;

    fn store() -> (Store, Arc<Clock>) {
        let clock = Arc::new(Clock(AtomicI64::new(T0)));
        (crate::test_support::store_with_env(clock.clone()), clock)
    }

    fn write(slug: &str, degraded: &str) -> SessionStateWrite {
        serde_json::from_value(json!({
            "standingEntities": ["people/a"],
            "surfacedSlugs": [slug],
            "lastWakeAt": "2026-11-19T00:00:00.123Z",
            "replaceStanding": false,
            "replaceCursorSlug": true,
            "factsCursorAt": null,
            "factsCursorId": null,
            "degradedWakes": degraded,
        }))
        .unwrap()
    }

    #[test]
    fn upsert_counts_incomplete_wakes() {
        let (s, _) = store();
        assert_eq!(
            s.upsert_session_state("default", "c", "s", &write("a", "increment"))
                .unwrap(),
            1
        );
        assert_eq!(
            s.upsert_session_state("default", "c", "s", &write("b", "increment"))
                .unwrap(),
            2
        );
        assert_eq!(
            s.upsert_session_state("default", "c", "s", &write("b", "keep"))
                .unwrap(),
            2
        );
        assert_eq!(
            s.upsert_session_state("default", "c", "s", &write("b", "reset"))
                .unwrap(),
            0
        );
        assert_eq!(
            s.upsert_session_state("default", "c", "t", &write("b", "keep"))
                .unwrap(),
            0
        );
        let err = s
            .upsert_session_state("default", "c\0x", "s", &write("b", "keep"))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        let mut bad = write("b", "keep");
        bad.last_wake_at = Some("yesterday".into());
        let err = s
            .upsert_session_state("default", "c", "s", &bad)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }

    #[test]
    fn cursor_keeps_what_the_flags_keep() {
        let (s, _) = store();
        s.upsert_session_state("default", "c", "s", &write("a", "keep"))
            .unwrap();
        let mut next = write("b", "keep");
        next.standing_entities = json!(["people/b"]);
        next.replace_cursor_slug = false;
        next.last_wake_at = None;
        s.upsert_session_state("default", "c", "s", &next).unwrap();
        assert_eq!(
            s.read_session_cursor("default", "c", "s").unwrap().unwrap(),
            json!({
                "standing_entities": ["people/a"],
                "surfaced_slugs": ["a"],
                "last_wake_at": "2026-11-19T00:00:00.123000Z",
            })
        );
        assert_eq!(s.read_session_cursor("default", "c", "none").unwrap(), None);
    }

    #[test]
    fn delta_row_keeps_the_facts_cursor_pair() {
        let (s, _) = store();
        let mut first = write("a", "keep");
        first.facts_cursor_at = Some("2026-11-18T01:02:03.456789Z".into());
        first.facts_cursor_id = Some(42.0);
        s.upsert_session_state("default", "c", "s", &first).unwrap();
        let mut next = write("a", "increment");
        next.facts_cursor_id = Some(7.0);
        s.upsert_session_state("default", "c", "s", &next).unwrap();
        assert_eq!(
            s.read_delta_session_row("default", "c", "s")
                .unwrap()
                .unwrap(),
            json!({
                "surfaced_slugs": ["a"],
                "last_wake_at": "2026-11-19T00:00:00.123000Z",
                "facts_cursor_at": "2026-11-18T01:02:03.456789Z",
                "facts_cursor_id": 42,
                "degraded_wakes": 1,
            })
        );
    }

    #[test]
    fn manifest_write_keeps_the_cursor() {
        let (s, _) = store();
        s.write_checkpoint_manifest("default", "c", "new", &json!([{ "slug": "a" }]))
            .unwrap();
        assert_eq!(
            s.read_session_cursor("default", "c", "new")
                .unwrap()
                .unwrap(),
            json!({ "standing_entities": [], "surfaced_slugs": [], "last_wake_at": null })
        );
        s.upsert_session_state("default", "c", "s", &write("a", "increment"))
            .unwrap();
        s.write_checkpoint_manifest("default", "c", "s", &json!([{ "slug": "b", "at": 1 }]))
            .unwrap();
        assert_eq!(
            s.read_checkpoint_manifest_row("default", "c", "s")
                .unwrap()
                .unwrap(),
            json!({ "checkpoint_manifest": [{ "at": 1, "slug": "b" }] })
        );
        assert_eq!(
            s.read_delta_session_row("default", "c", "s")
                .unwrap()
                .unwrap()["degraded_wakes"],
            1
        );
    }

    #[test]
    fn age_out_deletes_rows_older_than_whole_days() {
        let (s, clock) = store();
        s.upsert_session_state("default", "c", "old", &write("a", "keep"))
            .unwrap();
        clock.0.store(T0 + 1, Ordering::SeqCst);
        s.upsert_session_state("default", "c", "edge", &write("a", "keep"))
            .unwrap();
        clock.0.store(T0 + 1 + 7 * 86_400_000_000, Ordering::SeqCst);
        s.age_out_session_state(7.0).unwrap();
        assert!(
            s.read_session_cursor("default", "c", "old")
                .unwrap()
                .is_none()
        );
        assert!(
            s.read_session_cursor("default", "c", "edge")
                .unwrap()
                .is_some()
        );
        assert!(s.age_out_session_state(1.5).is_err());
    }

    fn kept(s: &Store) -> Vec<String> {
        let read = s.read().unwrap();
        let mut out: Vec<String> = all_rows(&*read)
            .unwrap()
            .into_iter()
            .map(|(k, _)| {
                let parts: Vec<String> = k[1..]
                    .split(|b| *b == 0)
                    .map(|p| String::from_utf8(p.to_vec()).unwrap())
                    .collect();
                format!("{}/{}", parts[1], parts[2])
            })
            .collect();
        out.sort();
        out
    }

    /// Writes `rows` (client, session) at one time, as one Postgres transaction does, then caps.
    fn tied(rows: &[(&str, String)], cap: f64) -> Vec<String> {
        let (s, _) = store();
        for (client, session) in rows {
            s.upsert_session_state("default", client, session, &write("a", "keep"))
                .unwrap();
        }
        s.cap_session_state_per_client(cap).unwrap();
        kept(&s)
    }

    fn one_lane(order: &[&str]) -> Vec<(&'static str, String)> {
        order.iter().map(|s| ("c", (*s).to_string())).collect()
    }

    #[test]
    fn cap_keeps_the_newest_rows_per_lane() {
        let (s, clock) = store();
        for (i, session) in ["s1", "s2", "s3", "s4"].iter().enumerate() {
            clock.0.store(T0 + i as i64, Ordering::SeqCst);
            s.upsert_session_state("default", "c", session, &write("a", "keep"))
                .unwrap();
            s.upsert_session_state("other", "c", session, &write("a", "keep"))
                .unwrap();
        }
        s.cap_session_state_per_client(2.0).unwrap();
        assert_eq!(kept(&s), ["c/s3", "c/s3", "c/s4", "c/s4"]);
    }

    /// Rows with equal `updated_at` rank by `session_id` bytes, whatever the write order (the 10 tie
    /// cases of test/engine-parity/session-state-cap.test.ts).
    #[test]
    fn cap_breaks_ties_by_session_id_bytes() {
        for order in [
            ["s1", "s2", "s3", "s4", "s5"],
            ["s5", "s4", "s3", "s2", "s1"],
            ["s3", "s1", "s5", "s2", "s4"],
        ] {
            assert_eq!(tied(&one_lane(&order), 2.0), ["c/s1", "c/s2"]);
        }
        let twelve = [
            "k07", "k03", "k11", "k01", "k09", "k12", "k05", "k02", "k10", "k04", "k08", "k06",
        ];
        assert_eq!(
            tied(&one_lane(&twelve), 5.0),
            ["c/k01", "c/k02", "c/k03", "c/k04", "c/k05"]
        );
        let two_lanes = |n: usize| -> Vec<(&'static str, String)> {
            (0..n)
                .map(|i| {
                    (
                        if i % 2 == 1 { "c" } else { "d" },
                        format!("m{:02}", (i * 17) % n),
                    )
                })
                .collect()
        };
        assert_eq!(tied(&two_lanes(6), 1.0), ["c/m01", "d/m00"]);
        assert_eq!(tied(&two_lanes(7), 1.0), ["c/m01", "d/m00"]);
        for n in [8, 10] {
            assert_eq!(
                tied(&two_lanes(n), 2.0),
                ["c/m01", "c/m03", "d/m00", "d/m02"]
            );
        }
        assert_eq!(
            tied(&two_lanes(40), 10.0),
            [
                "c/m01", "c/m03", "c/m05", "c/m07", "c/m09", "c/m11", "c/m13", "c/m15", "c/m17",
                "c/m19", "d/m00", "d/m02", "d/m04", "d/m06", "d/m08", "d/m10", "d/m12", "d/m14",
                "d/m16", "d/m18"
            ]
        );
        // Bytes, not a locale: "S2" (0x53) sorts before "s1" (0x73), and a prefix before a longer id.
        assert_eq!(
            tied(&one_lane(&["s1", "S2", "s", "s10"]), 2.0),
            ["c/S2", "c/s"]
        );
    }

    /// Rows rewritten in one transaction tie again and rank by `session_id` bytes, not rewrite order.
    #[test]
    fn cap_ignores_rewrite_order() {
        let (s, clock) = store();
        for session in ["s1", "s2", "s3", "s4", "s5"] {
            s.upsert_session_state("default", "c", session, &write("a", "keep"))
                .unwrap();
        }
        clock.0.store(T0 + 1, Ordering::SeqCst);
        for session in ["s5", "s3", "s1", "s4", "s2"] {
            s.upsert_session_state("default", "c", session, &write("b", "keep"))
                .unwrap();
        }
        s.cap_session_state_per_client(2.0).unwrap();
        assert_eq!(kept(&s), ["c/s1", "c/s2"]);
    }
}
