//! Clock invariants of the commit record (I-4.v2) and of row times (I-4.v2.1), as checks over a decoded log and over the times
//! a test read back. Pure functions: each returns the first violation as text, so a control can show it fails.
//!
//! - `commit_time` strictly rises in commit-position order across the whole log and equals `Store::last_commit_time()` after a
//!   recovery or a replay;
//! - every row time written after open is at or above the clock floor taken at open, on a store promoted from the log too (the
//!   floor is `max(local M\0ctime, last applied record's commit_time)`);
//! - nothing here orders by `created_at` to mean commit order: order is the commit position.

use super::mu::{CommitPosition, CommitRecord};

/// The records are in strictly rising position order and their commit times strictly rise with it.
pub fn commit_times_rise(records: &[CommitRecord]) -> Result<(), String> {
    for pair in records.windows(2) {
        let (a, b): (&CommitRecord, &CommitRecord) = (&pair[0], &pair[1]);
        if a.position >= b.position {
            return Err(format!(
                "records are not in position order: {:?} then {:?}",
                a.position, b.position
            ));
        }
        if b.commit_time <= a.commit_time {
            return Err(format!(
                "commit_time {} at {:?} does not rise above {} at {:?}",
                b.commit_time, b.position, a.commit_time, a.position
            ));
        }
    }
    Ok(())
}

/// After a recovery or a replay the newest record's commit time is what `last_commit_time()` reports (`None` for an empty log).
pub fn last_commit_time_matches(
    records: &[CommitRecord],
    last_commit_time: Option<i64>,
) -> Result<(), String> {
    let newest = records.last().map(|r| r.commit_time);
    if newest == last_commit_time {
        Ok(())
    } else {
        Err(format!(
            "last_commit_time is {last_commit_time:?}, the newest record's commit_time is {newest:?}"
        ))
    }
}

/// Every row time written after open is at or above the floor read at open.
pub fn row_times_at_or_above_floor(floor: i64, row_times_us: &[i64]) -> Result<(), String> {
    match row_times_us.iter().find(|&&t| t < floor) {
        None => Ok(()),
        Some(t) => Err(format!(
            "a row time {t} is below the clock floor {floor} read at open"
        )),
    }
}

/// The three checks together, as a replay or a recovery runs them.
pub fn replay_clock_checks(
    records: &[CommitRecord],
    last_commit_time: Option<i64>,
    floor: Option<i64>,
    row_times_us: &[i64],
) -> Result<(), String> {
    commit_times_rise(records)?;
    last_commit_time_matches(records, last_commit_time)?;
    if let Some(floor) = floor {
        row_times_at_or_above_floor(floor, row_times_us)?;
    }
    Ok(())
}

/// The floor a promoted primary starts with: the larger of its own `M\0ctime` and the last applied record's commit time.
pub fn floor_of(local_ctime: Option<i64>, last_applied: Option<&CommitRecord>) -> Option<i64> {
    super::mu::clock_floor(local_ctime, last_applied)
}

/// A synthetic record for the controls.
pub fn record(sequence: u64, index: u32, commit_time: i64) -> CommitRecord {
    CommitRecord {
        position: CommitPosition { sequence, index },
        origin: super::mu::WriteOrigin {
            host_id: "host".into(),
            incarnation: "incarnation".into(),
            writer_id: "local_cli:test".into(),
        },
        commit_time,
        write_ids: Vec::new(),
        ops: Vec::new(),
    }
}

/// The commit time I-4.v2 gives each commit: `max(store clock at the commit, previous commit time + 1 µs)`. `prev` is the commit
/// time before the first of these (`None` for none), `clocks[i]` the injected store clock when commit `i` was accepted.
pub fn exact_commit_times(prev: Option<i64>, clocks: &[i64]) -> Vec<i64> {
    let mut out = Vec::with_capacity(clocks.len());
    let mut last = prev;
    for &clock in clocks {
        let t = last.map_or(clock, |p| clock.max(p + 1));
        out.push(t);
        last = Some(t);
    }
    out
}

/// The records' commit times are exactly `max(store clock, previous + 1 µs)` for the clock readings given; an increasing counter
/// that ignores the clock fails here though it rises.
pub fn commit_times_are_exact(
    records: &[CommitRecord],
    prev: Option<i64>,
    clocks: &[i64],
) -> Result<(), String> {
    if records.len() != clocks.len() {
        return Err(format!(
            "{} records for {} clock readings",
            records.len(),
            clocks.len()
        ));
    }
    let want = exact_commit_times(prev, clocks);
    for (i, (r, w)) in records.iter().zip(&want).enumerate() {
        if r.commit_time != *w {
            return Err(format!(
                "commit {i} has commit_time {}, max(clock {}, previous + 1) is {w}",
                r.commit_time, clocks[i]
            ));
        }
    }
    Ok(())
}

/// Every returned position matches exactly one record at that position, and the records hold no position nobody was told about
/// beyond `extra_allowed` (open-time upkeep records, which no commit call returned).
pub fn positions_match_records(
    returned: &[CommitPosition],
    records: &[CommitRecord],
    extra_allowed: usize,
) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for r in records {
        if !seen.insert(r.position) {
            return Err(format!("two records share position {:?}", r.position));
        }
    }
    let mut told = std::collections::BTreeSet::new();
    for p in returned {
        if !told.insert(*p) {
            return Err(format!("two commits were returned position {p:?}"));
        }
        if !seen.contains(p) {
            return Err(format!("returned position {p:?} has no record"));
        }
    }
    let extra = seen.len() - told.len();
    if extra > extra_allowed {
        return Err(format!(
            "{extra} records match no returned position (at most {extra_allowed} allowed)"
        ));
    }
    Ok(())
}

/// Every acknowledged request id appears in the write ids of exactly one record.
pub fn request_ids_match_records(acked: &[String], records: &[CommitRecord]) -> Result<(), String> {
    for id in acked {
        let n = records.iter().filter(|r| r.write_ids.contains(id)).count();
        if n != 1 {
            return Err(format!(
                "acknowledged request {id} is in {n} records' write ids, not exactly one"
            ));
        }
    }
    Ok(())
}
