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
//! clock, as Postgres `now()` is the transaction start). `write_seq` numbers the writes in order:
//! it stands for the heap order a Postgres sequential scan returns, which the LRU cap's sort sees
//! as its input order (see `cap_session_state_per_client`).
//!
//! JSON columns are stored as given and read back in Postgres `jsonb` key order
//! (`crate::dream::jsonb`), which is what a PGLite read returns.

use crate::dream::jsonb_check;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::KvWrite;
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
    write_seq: u64,
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
            write_seq: 0,
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

/// The counter of `write_seq` (`keys::meta`).
const WRITE_SEQ: &str = "next_session_state_seq";

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

/// Writes `record` with this write's time and the next `write_seq`.
fn put_record(tx: &mut dyn KvWrite, key: &[u8], mut record: SessionRecord, now: i64) -> Result<()> {
    record.updated_at_us = now;
    record.write_seq = crate::pages::next_id(tx, WRITE_SEQ)?;
    put_json(tx, key, &record)
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
}
