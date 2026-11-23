//! The `dream_synthesis_completions` archive (schema migration v168): the idempotency keys of
//! completed dream synthesis children that `pruneJobs` deleted, so a pruned transcript is never
//! synthesized again. `pruneJobs` (`sweeps.rs`) writes it in the delete's transaction; the two
//! reads here are the ones `src/core/cycle/synthesize-completion.ts` runs, each a union of the
//! completed `minion_jobs` rows and the archive.
//!
//! Keys: every record starts with `keys::DREAM_SYNTHESIS_COMPLETION` (`f`):
//! - `a source_id \0 idempotency_key -> CompletionRecord`: one archive row. The key is the
//!   table's primary key `(source_id, idempotency_key)`; neither part contains `\0` (Postgres
//!   text cannot), so a prefix scan of `a source_id \0 key_prefix` is `LIKE 'key_prefix%'`.

use super::reads::hours_us;
use super::*;
use crate::error::STORE_CORRUPT;

/// The `dream:synth%` keys `pruneJobs` archives (`idempotency_key LIKE 'dream:synth%'`).
pub(super) const SYNTHESIS_KEY_PREFIX: &str = "dream:synth";
/// The key family `listRecentSynthesisCompletions` reads (`LIKE 'dream:synth-v2:%'`).
const SYNTH_V2_PREFIX: &str = "dream:synth-v2:";

/// One archive row's value: `completed_at`, UTC microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CompletionRecord {
    completed_at: i64,
}

fn completion_key(source_id: &str, idempotency_key: &str) -> Vec<u8> {
    keys::text(
        keys::DREAM_SYNTHESIS_COMPLETION,
        &[source_id, idempotency_key],
    )
}

/// `COALESCE(NULLIF(data->>'source_id', ''), 'default')`.
fn synthesis_source(data: &Value) -> String {
    data.as_object()
        .and_then(|o| o.get("source_id"))
        .and_then(jsonb_field_text)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into())
}

/// A completed `subagent` row of `source_id` whose key starts with `prefix`: its key.
fn completed_synthesis_key<'a>(r: &'a JobRecord, source_id: &str, prefix: &str) -> Option<&'a str> {
    if r.name != "subagent" || r.status != "completed" {
        return None;
    }
    let key = r.idempotency_key.as_deref()?;
    (key.starts_with(prefix) && synthesis_source(&r.data) == source_id).then_some(key)
}

/// The archive rows of `source_id` whose key starts with `prefix`, in key order.
fn archived(
    read: &dyn KvRead,
    source_id: &str,
    prefix: &str,
) -> Result<Vec<(String, CompletionRecord)>> {
    let mut scan = keys::text(keys::DREAM_SYNTHESIS_COMPLETION, &[source_id, ""]);
    scan.extend_from_slice(prefix.as_bytes());
    let skip = scan.len() - prefix.len();
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, &scan, false, &mut |k, v| match (
        std::str::from_utf8(&k[skip..]),
        serde_json::from_slice::<CompletionRecord>(v),
    ) {
        (Ok(key), Ok(record)) => {
            rows.push((key.to_owned(), record));
            true
        }
        (Err(_), _) => {
            bad = Some(StoreError::new(
                STORE_CORRUPT,
                "dream synthesis completion key is not UTF-8",
            ));
            false
        }
        (_, Err(e)) => {
            bad = Some(e.into());
            false
        }
    })?;
    match bad {
        Some(e) => Err(e),
        None => Ok(rows),
    }
}

/// The prune's `archived` CTE for one deleted row: a completed `subagent` with a `dream:synth%`
/// key goes into the archive as `(source, key, COALESCE(finished_at, now()))`, `ON CONFLICT DO
/// NOTHING`. Whether the row qualified.
pub(super) fn archive_pruned(tx: &mut dyn KvWrite, row: &JobRecord, now: i64) -> Result<bool> {
    if row.name != "subagent" || row.status != "completed" {
        return Ok(false);
    }
    let Some(key) = row
        .idempotency_key
        .as_deref()
        .filter(|k| k.starts_with(SYNTHESIS_KEY_PREFIX))
    else {
        return Ok(false);
    };
    let record_key = completion_key(&synthesis_source(&row.data), key);
    if tx.get(&record_key)?.is_none() {
        let record = CompletionRecord {
            completed_at: row.finished_at.unwrap_or(now),
        };
        put_json(tx, &record_key, &record)?;
    }
    Ok(true)
}

/// The shadow seed (`seed.rs`): stores an archive row copied from another engine with its own
/// `completed_at`. `false` when `(source_id, idempotency_key)` already holds a row.
pub(crate) fn seed_completion(
    tx: &mut dyn KvWrite,
    source_id: &str,
    idempotency_key: &str,
    completed_at_us: i64,
) -> Result<bool> {
    let key = completion_key(source_id, idempotency_key);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    let record = CompletionRecord {
        completed_at: completed_at_us,
    };
    put_json(tx, &key, &record)?;
    Ok(true)
}

impl Store {
    /// `listSynthesisCompletionKeys(sourceId, keyPrefix)`: the keys starting with `keyPrefix` of
    /// the source's completed `subagent` jobs and of its archive rows, each once (`UNION`). The
    /// SQL engines return them in no set order; this store returns them in byte order.
    pub fn list_synthesis_completion_keys(
        &self,
        source_id: &str,
        key_prefix: &str,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut keys: BTreeSet<String> = rows_with_status(&*read, "completed")?
            .iter()
            .filter_map(|r| completed_synthesis_key(r, source_id, key_prefix).map(str::to_owned))
            .collect();
        keys.extend(
            archived(&*read, source_id, key_prefix)?
                .into_iter()
                .map(|(k, _)| k),
        );
        Ok(keys.into_iter().collect())
    }

    /// `listRecentSynthesisCompletions(sourceId, hours)`: `{ idempotency_key, at }` for each
    /// `dream:synth-v2:` completion of the source after `now() - hours`: completed `subagent`
    /// jobs by `finished_at` (id order), then archive rows by `completed_at` (key order), every
    /// row kept (`UNION ALL`). `at` is ISO.
    pub fn list_recent_synthesis_completions(
        &self,
        source_id: &str,
        hours: f64,
    ) -> Result<Vec<Value>> {
        if !hours.is_finite() {
            return Err(StoreError::invalid(format!(
                "listRecentSynthesisCompletions: hours is not a number: {hours}"
            )));
        }
        let read = self.read()?;
        let cutoff = self.env.now_micros() - hours_us(hours);
        let mut out = Vec::new();
        for r in rows_with_status(&*read, "completed")? {
            let Some(at) = r.finished_at.filter(|at| *at > cutoff) else {
                continue;
            };
            if let Some(key) = completed_synthesis_key(&r, source_id, SYNTH_V2_PREFIX) {
                out.push(json!({ "idempotency_key": key, "at": iso(at) }));
            }
        }
        for (key, record) in archived(&*read, source_id, SYNTH_V2_PREFIX)? {
            if record.completed_at > cutoff {
                out.push(json!({ "idempotency_key": key, "at": iso(record.completed_at) }));
            }
        }
        Ok(out)
    }
}

/// The shadow follow (`seed/follow.rs`): removes the archive row `(source_id, idempotency_key)`.
/// `false` when there is none.
pub(crate) fn remove_completion(
    tx: &mut dyn KvWrite,
    source_id: &str,
    idempotency_key: &str,
) -> Result<bool> {
    let key = completion_key(source_id, idempotency_key);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}
