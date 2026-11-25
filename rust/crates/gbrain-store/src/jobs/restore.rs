//! Jobs: the queue's part of a restore (`restore.rs`).

use super::*;

/// How many jobs are not finished (waiting, active, delayed, waiting-children or paused).
pub(crate) fn live_job_count(read: &dyn KvRead) -> Result<u64> {
    let mut live = 0;
    for status in NON_TERMINAL {
        live += ids_under(read, &status_prefix(status))?.len() as u64;
    }
    Ok(live)
}

/// PGLite's restore UPDATE on `minion_jobs`: every unfinished job becomes `cancelled`, its lease
/// cleared, with its previous status and the restore id kept in `data`. Parents are not told: a
/// restored job never runs, so nothing waits for its children. Returns how many changed.
pub(crate) fn quarantine_jobs(tx: &mut dyn KvWrite, restore_id: &str, now: i64) -> Result<u64> {
    let mut changed = 0;
    for status in NON_TERMINAL {
        for old in rows_with_status(&*tx, status)? {
            let mut new = old.clone();
            new.status = "cancelled".into();
            new.lock_token = None;
            new.lock_until = None;
            new.finished_at = Some(now);
            new.updated_at = now;
            new.error_text =
                Some("quarantined by backup restore; inspect and explicitly resubmit".into());
            // A payload that is not an object (an array, a string, a number) is kept whole under its own key.
            let mut data = match std::mem::take(&mut new.data) {
                Value::Object(map) => map,
                Value::Null => Map::new(),
                other => Map::from_iter([("__restore_original_data".to_string(), other)]),
            };
            data.insert("__restore_previous_status".into(), json!(old.status));
            data.insert("__restore_id".into(), json!(restore_id));
            new.data = Value::Object(data);
            save(tx, Some(&old), &new)?;
            changed += 1;
        }
    }
    Ok(changed)
}
