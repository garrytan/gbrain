//! Volunteered-page events: the `context_volunteer_events` table of the PGLite engine, as the members of
//! `src/core/engine-sql/volunteer-events.ts` run it (rust/docs/store/volunteer-events.md).
//!
//! Members: insertVolunteerEvents, readVolunteerUsage.
//!
//! Keys (every record starts with `keys::TELEMETRY`, `a`):
//! - `a 0x0C id BE8 -> VolunteerRecord`: one event, its id the `BIGSERIAL`.
//! - `a 0x0D -> last id` (JSON integer): the id sequence.
//!
//! The 90-day purge (`purgeStaleVolunteerEvents`) stays raw SQL and refuses on a Rust brain. A page is "used" when its
//! retrieval record (`page_ops/retrievals.rs`) is later than the event, as `GREATEST(p.last_retrieved_at,
//! r.last_retrieved_at) > e.volunteered_at` reads it: a Rust page has no separate column.

use crate::error::Result;
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::{Store, get_json, keys, page_ops, pages, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const OP_INSERT: &str = "insertVolunteerEvents";
const DAY_US: i64 = 86_400_000_000;

fn event_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_VOLUNTEER_EVENT]
}

fn sequence_key() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_VOLUNTEER_SEQUENCE]
}

/// One `context_volunteer_events` row; `volunteered_at` is microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VolunteerRecord {
    source_id: String,
    slug: String,
    confidence: f64,
    match_arm: String,
    rationale: String,
    channel: String,
    session_id: Option<String>,
    turn: Option<i32>,
    volunteered_at: i64,
}

/// One volunteered page of `insertVolunteerEvents`.
#[derive(Debug, Clone, Deserialize)]
pub struct VolunteerEventInput {
    pub source_id: String,
    pub slug: String,
    pub confidence: f64,
    pub match_arm: String,
    #[serde(default)]
    pub rationale: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub turn: Option<i32>,
}

fn default_channel() -> String {
    "op".to_string()
}

impl Store {
    /// `insertVolunteerEvents(rows)`: one event per row whose page row exists (deleted or not), all stamped now.
    pub fn insert_volunteer_events(&self, rows: &[VolunteerEventInput]) -> Result<()> {
        for r in rows {
            no_nul(
                OP_INSERT,
                &[
                    ("source_id", &r.source_id),
                    ("slug", &r.slug),
                    ("match_arm", &r.match_arm),
                    ("rationale", &r.rationale),
                    ("channel", &r.channel),
                    ("session_id", r.session_id.as_deref().unwrap_or("")),
                ],
            )?;
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut last = get_json::<i64>(&*tx, &sequence_key())?.unwrap_or(0);
            for r in rows {
                if pages::read_page(&*tx, &r.source_id, &r.slug)?.is_none() {
                    continue;
                }
                last += 1;
                let mut k = event_prefix().to_vec();
                k.extend_from_slice(&(last as u64).to_be_bytes());
                put_json(
                    tx,
                    &k,
                    &VolunteerRecord {
                        source_id: r.source_id.clone(),
                        slug: r.slug.clone(),
                        confidence: r.confidence,
                        match_arm: r.match_arm.clone(),
                        rationale: r.rationale.clone(),
                        channel: r.channel.clone(),
                        session_id: r.session_id.clone(),
                        turn: r.turn,
                        volunteered_at: now,
                    },
                )?;
            }
            put_json(tx, &sequence_key(), &last)
        })
    }

    /// `listVolunteerChannels(sourceIds)`: `{ channel, n, last_fired }` per channel over the events of the last 7 days
    /// (of those sources, or every source when `None`), by byte of channel; `last_fired` is the newest event time.
    pub fn list_volunteer_channels(&self, source_ids: Option<&[String]>) -> Result<Value> {
        let read = self.read()?;
        let cutoff = self.env.now_micros().saturating_sub(7 * DAY_US);
        let mut groups: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for (_, e) in all_events(&*read)? {
            if e.volunteered_at <= cutoff
                || source_ids.is_some_and(|ids| !ids.contains(&e.source_id))
            {
                continue;
            }
            let slot = groups.entry(e.channel).or_insert((0, i64::MIN));
            slot.0 += 1;
            slot.1 = slot.1.max(e.volunteered_at);
        }
        Ok(Value::Array(
            groups
                .into_iter()
                .map(|(channel, (n, last))| json!({ "channel": channel, "n": n, "last_fired": crate::env::iso(last) }))
                .collect(),
        ))
    }

    /// `readVolunteerUsage(sourceIds, days)`: `{ match_arm, channel, volunteered, used }` per arm and channel over the
    /// events of those sources newer than `days` days, by byte of arm then channel.
    pub fn read_volunteer_usage(&self, source_ids: &[String], days: i64) -> Result<Value> {
        let read = self.read()?;
        let cutoff = self
            .env
            .now_micros()
            .saturating_sub(days.saturating_mul(DAY_US));
        let events = all_events(&*read)?;
        let mut groups: BTreeMap<(String, String), (i64, i64)> = BTreeMap::new();
        for (_, e) in events {
            if !source_ids.contains(&e.source_id) || e.volunteered_at <= cutoff {
                continue;
            }
            let used = match pages::read_page(&*read, &e.source_id, &e.slug)? {
                Some(p) if p.deleted_at_us.is_none() => {
                    page_ops::retrievals::last_retrieved_us(&*read, p.id)?
                        .is_some_and(|at| at > e.volunteered_at)
                }
                _ => false,
            };
            let slot = groups.entry((e.match_arm, e.channel)).or_insert((0, 0));
            slot.0 += 1;
            slot.1 += i64::from(used);
        }
        Ok(Value::Array(
            groups
                .into_iter()
                .map(|((arm, channel), (n, used))| {
                    json!({ "match_arm": arm, "channel": channel, "volunteered": n, "used": used })
                })
                .collect(),
        ))
    }
}

fn all_events(read: &dyn crate::kv::KvRead) -> Result<Vec<(Vec<u8>, VolunteerRecord)>> {
    let mut events = Vec::new();
    let mut bad = None;
    scan_prefix(read, &event_prefix(), false, &mut |k, v| {
        match serde_json::from_slice::<VolunteerRecord>(v) {
            Ok(r) => events.push((k.to_vec(), r)),
            Err(e) => {
                bad = Some(crate::error::StoreError::invalid(format!(
                    "unreadable volunteer event record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(events), Err)
}

/// The volunteer log rows of a hard-deleted page's slug go with it (`scrubPurgedNameStores`,
/// src/core/persistence/purge-name-stores.ts): every event of `source_id` naming one of `slugs`.
pub(crate) fn scrub_purged_slugs(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    slugs: &[String],
) -> Result<()> {
    for (key, e) in all_events(&*tx)? {
        if e.source_id == source_id && slugs.contains(&e.slug) {
            tx.delete(&key)?;
        }
    }
    Ok(())
}

/// The `context_volunteer_events` rows a purge probe searches (src/core/deletion-inventory.ts).
pub(crate) fn purge_probe_rows(
    read: &dyn crate::kv::KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    Ok(all_events(read)?
        .into_iter()
        .map(|(_, e)| ProbeRow {
            cells: vec![
                ("source_id", ProbeCell::text(&e.source_id)),
                ("slug", ProbeCell::text(&e.slug)),
                ("match_arm", ProbeCell::text(&e.match_arm)),
                ("rationale", ProbeCell::text(&e.rationale)),
                ("channel", ProbeCell::text(&e.channel)),
                ("session_id", ProbeCell::opt_text(e.session_id.as_deref())),
            ],
            source_id: Some(e.source_id),
        })
        .collect())
}

/// The volunteer log rows of a removed source (`removedSourceScrubCtes`, src/core/engine-sql/sources.ts).
pub(crate) fn remove_source_rows(tx: &mut dyn crate::kv::KvWrite, source_id: &str) -> Result<()> {
    for (key, e) in all_events(&*tx)? {
        if e.source_id == source_id {
            tx.delete(&key)?;
        }
    }
    Ok(())
}
