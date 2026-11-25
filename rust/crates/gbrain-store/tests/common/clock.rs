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
        if b.commit_time_us <= a.commit_time_us {
            return Err(format!(
                "commit_time {} at {:?} does not rise above {} at {:?}",
                b.commit_time_us, b.position, a.commit_time_us, a.position
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
    let newest = records.last().map(|r| r.commit_time_us);
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
pub fn record(sequence: u64, index: u32, commit_time_us: i64) -> CommitRecord {
    CommitRecord {
        version: 2,
        position: CommitPosition { sequence, index },
        origin: super::mu::WriteOrigin {
            host_id: "host".into(),
            incarnation: "incarnation".into(),
            writer_id: "local_cli:test".into(),
        },
        commit_time_us,
        write_ids: Vec::new(),
        ops: Vec::new(),
    }
}
