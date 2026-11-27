//! The withdrawal ledger of a page snapshot (src/core/page-state/snapshot.ts): the `withdrawals` and
//! `globalPurges` fields `readPageSnapshot` and `readPageSnapshotsBatch` answer, read from the
//! withdrawal ledger (`t 0x01`, `trust::withdrawals`) and the purge ledger (`F 0x0F`,
//! `facts::purge_ledger`); it has no key range of its own.
//!
//! - `withdrawals`: per `(visibility, fact_hash)` the earliest withdrawal of the source under
//!   subject `*` or the page's slug, then per `(visibility, fact_hash)` the earliest tombstone under
//!   the slug (`purged: true`), each part in `(visibility, fact_hash)` order.
//! - `globalPurges`: `{count, latest, world_only}` of the source's tombstones under subject `*`,
//!   only when there is one.
//! - `globalPurgeRows`: those tombstones, one per `(visibility, fact_hash)` with its earliest time.
//!   Postgres keeps only the ones whose hash a fence claim of the page has (`resolveGlobalPurges`);
//!   the TS member makes that cut, as it needs the fence parser, and drops the field.
//!
//! With `world_only` (the read's `excludePrivate`), only `world` rows count, as Postgres filters
//! `visibility='world'`. The TS member overlays the rows on the page text (`overlayWithdrawalBody`).

use crate::env::iso;
use crate::error::Result;
use crate::facts::purge_ledger::purges_under_subject;
use crate::kv::KvRead;
use crate::trust::withdrawals::under_subject;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// A timestamptz as `jsonb_build_object` writes it, as the SQL snapshot statement's ledger rows
/// carry it: `2026-03-05T10:00:00.25+00:00` (trailing zeros of the fraction dropped).
fn jsonb_time(micros: i64) -> String {
    format!(
        "{}:00",
        crate::timeline_queries::timestamptz_text(micros).replacen(' ', "T", 1)
    )
}

/// The two values of the ledgers' `visibility` CHECK, in text order.
const VISIBILITIES: [&str; 2] = ["private", "world"];

fn visibilities(world_only: bool) -> &'static [&'static str] {
    if world_only {
        &VISIBILITIES[1..]
    } else {
        &VISIBILITIES
    }
}

/// One ledger's `(fact_hash, time)` rows under a visibility and subject.
type SubjectScan<'a> = &'a dyn Fn(&str, &str) -> Result<Vec<(String, i64)>>;

/// The earliest time per `(visibility, fact_hash)` of the rows `scan` finds under each subject.
fn earliest(
    world_only: bool,
    subjects: &[&str],
    scan: SubjectScan<'_>,
) -> Result<BTreeMap<(String, String), i64>> {
    let mut out: BTreeMap<(String, String), i64> = BTreeMap::new();
    for vis in visibilities(world_only) {
        for subject in subjects {
            for (hash, us) in scan(vis, subject)? {
                let slot = out.entry(((*vis).to_string(), hash)).or_insert(us);
                *slot = (*slot).min(us);
            }
        }
    }
    Ok(out)
}

fn rows(map: BTreeMap<(String, String), i64>, purged: bool) -> Vec<Value> {
    map.into_iter()
        .map(|((visibility, fact_hash), us)| {
            let mut row =
                json!({"visibility": visibility, "fact_hash": fact_hash, "withdrawn_at": jsonb_time(us)});
            if purged {
                row["purged"] = Value::Bool(true);
            }
            row
        })
        .collect()
}

/// The snapshot fields `withdrawals`, `globalPurges` and `globalPurgeRows` of the page `slug` of
/// `source_id`.
pub(crate) fn snapshot_withdrawals(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
    world_only: bool,
) -> Result<Map<String, Value>> {
    let withdrawn = earliest(world_only, &["*", slug], &|vis, subject| {
        under_subject(read, source_id, vis, subject)
    })?;
    let purged = earliest(world_only, &[slug], &|vis, subject| {
        purges_under_subject(read, source_id, vis, subject)
    })?;
    let mut withdrawals = rows(withdrawn, false);
    withdrawals.extend(rows(purged, true));
    let mut out = Map::new();
    out.insert("withdrawals".into(), Value::Array(withdrawals));
    let mut count = 0usize;
    let mut latest: Option<i64> = None;
    for vis in visibilities(world_only) {
        for (_, us) in purges_under_subject(read, source_id, vis, "*")? {
            count += 1;
            latest = Some(latest.map_or(us, |l| l.max(us)));
        }
    }
    if count > 0 {
        let global = earliest(world_only, &["*"], &|vis, subject| {
            purges_under_subject(read, source_id, vis, subject)
        })?;
        out.insert(
            "globalPurges".into(),
            json!({"count": count, "latest": latest.map(iso), "world_only": world_only}),
        );
        out.insert("globalPurgeRows".into(), Value::Array(rows(global, true)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::purge_ledger::FactPurgeInsert;

    fn purge(store: &crate::Store, visibility: &str, subject: &str, hash: &str) {
        let row = FactPurgeInsert {
            source_id: "default".into(),
            visibility: visibility.into(),
            subject: subject.into(),
            fact_hash: hash.into(),
            request_id: None,
            actor: None,
            reason: None,
        };
        store.insert_fact_purge(&row).unwrap();
    }

    #[test]
    fn the_snapshot_ledger_takes_the_slug_and_star_rows_and_marks_global_purges() {
        let store = crate::test_support::store();
        let at = "2026-01-02T03:04:05.000000Z";
        store
            .insert_fact_withdrawal("default", "world", "b claim", "notes/a", Some(at))
            .unwrap();
        store
            .insert_fact_withdrawal("default", "private", "a claim", "*", Some(at))
            .unwrap();
        store
            .insert_fact_withdrawal("default", "world", "other", "notes/b", Some(at))
            .unwrap();
        purge(&store, "world", "notes/a", "h1");
        purge(&store, "world", "notes/b", "h2");
        let read = store.read().unwrap();
        let all = snapshot_withdrawals(&*read, "default", "notes/a", false).unwrap();
        let rows = all["withdrawals"].as_array().unwrap();
        let keys: Vec<(&str, bool)> = rows
            .iter()
            .map(|r| (r["visibility"].as_str().unwrap(), r["purged"] == true))
            .collect();
        assert_eq!(
            keys,
            vec![("private", false), ("world", false), ("world", true)]
        );
        assert_eq!(rows[0]["withdrawn_at"], "2026-01-02T03:04:05+00:00");
        assert!(all.get("globalPurges").is_none());
        let world = snapshot_withdrawals(&*read, "default", "notes/a", true).unwrap();
        assert_eq!(world["withdrawals"].as_array().unwrap().len(), 2);
        drop(read);
        purge(&store, "private", "*", "h3");
        let read = store.read().unwrap();
        let all = snapshot_withdrawals(&*read, "default", "notes/a", false).unwrap();
        assert_eq!(all["globalPurges"]["count"], 1);
        assert_eq!(all["globalPurgeRows"][0]["fact_hash"], "h3");
        let world = snapshot_withdrawals(&*read, "default", "notes/a", true).unwrap();
        assert!(world.get("globalPurges").is_none());
    }
}
