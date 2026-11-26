//! The two generation reads of `gbrain doctor` (`src/commands/doctor/checks/generations.ts`) over the
//! `derived_generations` rows of the parent module: the live generations that retired items inside the
//! restore window (`listLiveGenerationRetirements`) and the held generations by reason
//! (`listHeldGenerations`), the statements of `engine-sql/doctor-derived.ts`. Both read the ledger only
//! (no page, so no page read policy) and add no keys.

use super::{GenerationRecord, ItemRecord, item_prefix, source_records};
use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::error::Result;
use crate::kv::collect_prefix;
use crate::links::no_nul;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The `source_id`s of a doctor read, each checked as a text argument (a NUL byte is refused as on Postgres).
fn source_set<'a>(op: &str, source_ids: &'a [String]) -> Result<BTreeSet<&'a str>> {
    for id in source_ids {
        no_nul(op, &[("source_id", id.as_str())])?;
    }
    Ok(source_ids.iter().map(String::as_str).collect())
}

impl Store {
    /// `listLiveGenerationRetirements(sourceIds, restoreDays)`: per source and kind (byte order), the live
    /// generations created inside the last `restore_days` days that hold a `retired` item: `keys` (the
    /// generations with one), `items` (the retired items) and `oldest` (the earliest creation time, as
    /// `timestamptz::text`). A source or kind with none is left out, as the join and `GROUP BY` leave it.
    pub fn list_live_generation_retirements(
        &self,
        source_ids: &[String],
        restore_days: f64,
    ) -> Result<Vec<Value>> {
        let sources = source_set("listLiveGenerationRetirements", source_ids)?;
        let read = self.read()?;
        // `now() - interval '1 day' * $2`: the day count scales the day field, so a fraction is a part of a day.
        let cutoff = self.env.now_micros() - (restore_days * 86_400_000_000.0).round() as i64;
        let mut groups: BTreeMap<(String, String), (u64, u64, i64)> = BTreeMap::new();
        for source in sources {
            for record in source_records(&*read, source)? {
                if record.state != "live" || record.created_at_us < cutoff {
                    continue;
                }
                let retired = retired_items(&*read, &record)?;
                if retired == 0 {
                    continue;
                }
                let group = groups
                    .entry((record.source_id.clone(), record.kind.clone()))
                    .or_insert((0, 0, i64::MAX));
                group.0 += 1;
                group.1 += retired;
                group.2 = group.2.min(record.created_at_us);
            }
        }
        Ok(groups
            .into_iter()
            .map(|((source_id, kind), (keys, items, oldest))| {
                json!({
                    "source_id": source_id,
                    "kind": kind,
                    "keys": keys,
                    "items": items,
                    "oldest": timestamptz_text(oldest),
                })
            })
            .collect())
    }

    /// `listHeldGenerations(sourceIds)`: per source, kind and held reason (byte order), the held
    /// generations of those sources: `count` and `oldest` (the earliest creation time, as `timestamptz::text`).
    pub fn list_held_generations(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let sources = source_set("listHeldGenerations", source_ids)?;
        let read = self.read()?;
        let mut groups: BTreeMap<(String, String, Option<String>), (u64, i64)> = BTreeMap::new();
        for source in sources {
            for record in source_records(&*read, source)? {
                if record.state != "held" {
                    continue;
                }
                let group = groups
                    .entry((
                        record.source_id.clone(),
                        record.kind.clone(),
                        record.held_reason.clone(),
                    ))
                    .or_insert((0, i64::MAX));
                group.0 += 1;
                group.1 = group.1.min(record.created_at_us);
            }
        }
        Ok(groups
            .into_iter()
            .map(|((source_id, kind, reason), (count, oldest))| {
                json!({
                    "source_id": source_id,
                    "kind": kind,
                    "held_reason": reason,
                    "count": count,
                    "oldest": timestamptz_text(oldest),
                })
            })
            .collect())
    }
}

/// The `retired` items of the generation `record`.
fn retired_items(read: &dyn crate::kv::KvRead, record: &GenerationRecord) -> Result<u64> {
    let mut retired = 0;
    for (_, value) in collect_prefix(read, &item_prefix(record.id), false, usize::MAX)? {
        let item: ItemRecord = serde_json::from_slice(&value)?;
        if item.action == "retired" {
            retired += 1;
        }
    }
    Ok(retired)
}
