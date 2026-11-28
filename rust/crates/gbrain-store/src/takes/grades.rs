//! The grade_takes verdict cache: the `take_grade_cache` table of the PGLite engine, and the
//! `gbrain takes grades` read over it (`src/core/engine-sql/takes-reads.ts`).
//!
//! Members: readTakeGrade, insertTakeGrade, deleteTakeGrade, listLatestTakeGrades, and the two
//! wave reads of `gbrain calibration --undo-wave`: listWaveAppliedTakeIds, unapplyWaveTakeGrades.
//!
//! Key: `A 0x05 <take id BE8> <prompt_version> 0x00 <judge_model_id> 0x00 <evidence_signature>`
//! -> `GradeRecord` (JSON). The key is the table's primary key, so a NUL byte in any of the three
//! texts is refused (Postgres text cannot hold one either). Like the table, a row names its take by
//! id only (no foreign key): it outlives a deleted take or source, and a read that joins the take
//! skips a row whose take or page is gone.
//!
//! `confidence` is a `REAL`: kept as `f32` and read back as the shortest decimal that names it, as
//! both SQL engines print it. `graded_at` is kept in microseconds and crosses as ISO 8601.

use super::nudges::WaveSpec;
use super::*;
use crate::error::INVALID_ARGUMENT;
use crate::telemetry::parse_timestamp;

const GRADE: u8 = 0x05;
const TABLE: &str = "take_grade_cache";
const DEFAULT_WAVE: &str = "v0.36.1.0";

/// The primary key of a cached verdict.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeGradeKey {
    pub take_id: i64,
    pub prompt_version: String,
    pub judge_model_id: String,
    pub evidence_signature: String,
}

/// `insertTakeGrade` row: the key, the verdict and, for an import or a fixture, its time.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeGradeInput {
    pub take_id: i64,
    pub prompt_version: String,
    pub judge_model_id: String,
    pub evidence_signature: String,
    pub verdict: String,
    pub confidence: f64,
    pub applied: bool,
    #[serde(default)]
    pub graded_at: Option<String>,
    /// The calibration wave that graded it; the column default when absent.
    #[serde(default)]
    pub wave_version: Option<String>,
}

/// `listLatestTakeGrades` filters: a null filter matches every row.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeGradeFilter {
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub min_confidence: Option<f64>,
    #[serde(default)]
    pub applied: Option<bool>,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GradeRecord {
    take_id: i64,
    prompt_version: String,
    judge_model_id: String,
    evidence_signature: String,
    wave_version: String,
    graded_at_us: i64,
    verdict: String,
    confidence: f32,
    applied: bool,
}

fn take_prefix(take_id: i64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, GRADE];
    // Postgres sorts a BIGINT by its signed value: flip the sign bit so the bytes do too.
    key.extend_from_slice(&((take_id as u64) ^ (1 << 63)).to_be_bytes());
    key
}

fn grade_key(
    op: &str,
    take_id: i64,
    prompt: &str,
    judge: &str,
    signature: &str,
) -> Result<Vec<u8>> {
    no_nul(
        op,
        &[
            ("prompt_version", prompt),
            ("judge_model_id", judge),
            ("evidence_signature", signature),
        ],
    )?;
    let mut key = take_prefix(take_id);
    for (i, part) in [prompt, judge, signature].iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    Ok(key)
}

/// A `REAL` value as the number both SQL engines print: the shortest decimal that names it.
pub(super) fn real(x: f32) -> f64 {
    x.to_string().parse().unwrap_or(f64::from(x))
}

/// A `REAL` parameter: refuses a NaN or infinity (native input only) and a finite number too large
/// for `f32`, as Postgres refuses it out of range.
pub(super) fn to_real(op: &str, x: f64) -> Result<f32> {
    if !x.is_finite() {
        return Err(StoreError::invalid(format!(
            "{op}: confidence is not a finite number"
        )));
    }
    let r = x as f32;
    if r.is_infinite() {
        return Err(StoreError::invalid(format!(
            "{op}: confidence is out of range for type real"
        )));
    }
    Ok(r)
}

/// The wave's applied verdicts, with their keys.
fn wave_grades(read: &dyn KvRead, wave_version: &str) -> Result<Vec<(Vec<u8>, GradeRecord)>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::TAKE, GRADE], false, &mut |k, v| {
        raw.push((k.to_vec(), v.to_vec()));
        true
    })?;
    let mut out = Vec::new();
    for (k, v) in raw {
        let r: GradeRecord = serde_json::from_slice(&v)?;
        if r.applied && r.wave_version == wave_version {
            out.push((k, r));
        }
    }
    Ok(out)
}

impl Store {
    /// `readTakeGrade(key)`: `{ verdict, confidence, applied }` of the row at the key, or `None`.
    pub fn read_take_grade(&self, key: &TakeGradeKey) -> Result<Option<Value>> {
        let k = grade_key(
            "readTakeGrade",
            key.take_id,
            &key.prompt_version,
            &key.judge_model_id,
            &key.evidence_signature,
        )?;
        let row: Option<GradeRecord> = get_json(&*self.read()?, &k)?;
        Ok(row.map(|r| json!({ "verdict": r.verdict, "confidence": real(r.confidence), "applied": r.applied })))
    }

    /// `insertTakeGrade(row)`: stores the verdict unless a row already holds its key (`ON CONFLICT
    /// DO NOTHING`). A verdict outside the four qualities fails the table's check constraint.
    pub fn insert_take_grade(&self, row: &TakeGradeInput) -> Result<()> {
        const OP: &str = "insertTakeGrade";
        let k = grade_key(
            OP,
            row.take_id,
            &row.prompt_version,
            &row.judge_model_id,
            &row.evidence_signature,
        )?;
        no_nul(OP, &[("verdict", &row.verdict)])?;
        if let Some(w) = &row.wave_version {
            no_nul(OP, &[("wave_version", w)])?;
        }
        if !QUALITIES.contains(&row.verdict.as_str()) {
            return Err(check_failed(TABLE, "take_grade_cache_verdict_check"));
        }
        let confidence = to_real(OP, row.confidence)?;
        let graded_at = row
            .graded_at
            .as_deref()
            .map(|t| parse_timestamp(OP, t))
            .transpose()?;
        self.write(|tx| {
            if tx.get(&k)?.is_some() {
                return Ok(());
            }
            let record = GradeRecord {
                take_id: row.take_id,
                prompt_version: row.prompt_version.clone(),
                judge_model_id: row.judge_model_id.clone(),
                evidence_signature: row.evidence_signature.clone(),
                wave_version: row
                    .wave_version
                    .clone()
                    .unwrap_or_else(|| DEFAULT_WAVE.to_string()),
                graded_at_us: graded_at.unwrap_or_else(|| self.env.now_micros()),
                verdict: row.verdict.clone(),
                confidence,
                applied: row.applied,
            };
            put_json(tx, &k, &record)
        })
    }

    /// `deleteTakeGrade(key)`: deletes the row at the key; a key with no row deletes nothing.
    pub fn delete_take_grade(&self, key: &TakeGradeKey) -> Result<()> {
        let k = grade_key(
            "deleteTakeGrade",
            key.take_id,
            &key.prompt_version,
            &key.judge_model_id,
            &key.evidence_signature,
        )?;
        self.write(|tx| {
            if tx.get(&k)?.is_some() {
                tx.delete(&k)?;
            }
            Ok(())
        })
    }

    /// `listWaveAppliedTakeIds(wave)`: the distinct take ids of the wave's applied verdicts,
    /// ascending. A verdict names its take by id only, so a deleted take's id still counts.
    pub fn list_wave_applied_take_ids(&self, wave_version: &str) -> Result<Vec<i64>> {
        no_nul("listWaveAppliedTakeIds", &[("wave_version", wave_version)])?;
        let ids: BTreeSet<i64> = wave_grades(&*self.read()?, wave_version)?
            .into_iter()
            .map(|(_, r)| r.take_id)
            .collect();
        Ok(ids.into_iter().collect())
    }

    /// `unapplyWaveTakeGrades(spec)`: the number of the wave's applied verdicts; marks them
    /// unapplied unless a dry run (the rows stay as the audit trail).
    pub fn unapply_wave_take_grades(&self, spec: &WaveSpec) -> Result<u64> {
        no_nul(
            "unapplyWaveTakeGrades",
            &[("wave_version", &spec.wave_version)],
        )?;
        if spec.dry_run {
            return Ok(wave_grades(&*self.read()?, &spec.wave_version)?.len() as u64);
        }
        self.write(|tx| {
            let rows = wave_grades(&*tx, &spec.wave_version)?;
            for (key, mut record) in rows.iter().cloned() {
                record.applied = false;
                put_json(tx, &key, &record)?;
            }
            Ok(rows.len() as u64)
        })
    }

    /// `countAppliedTakeGrades(sourceIds)`: the cached verdicts with `applied = true` (the doctor
    /// `grade_confidence_drift` count). With `sourceIds`, only those whose take exists on a page
    /// (in any state) of one of them, as the `take_id IN (SELECT t.id FROM takes t JOIN pages p
    /// ...)` filter reads it; without, every applied row, whether or not its take still exists.
    pub fn count_applied_take_grades(&self, source_ids: Option<&[String]>) -> Result<u64> {
        let read = self.read()?;
        let mut raw = Vec::new();
        scan_prefix(&*read, &[keys::TAKE, GRADE], false, &mut |_, v| {
            raw.push(v.to_vec());
            true
        })?;
        let mut count = 0;
        for bytes in raw {
            let r: GradeRecord = serde_json::from_slice(&bytes)?;
            if !r.applied {
                continue;
            }
            if let Some(ids) = source_ids {
                let Ok(id) = u64::try_from(r.take_id) else {
                    continue;
                };
                let Some(take) = read_take(&*read, id)? else {
                    continue;
                };
                let Some(page) = read_page_by_id(&*read, take.page_id)? else {
                    continue;
                };
                if !ids.contains(&page.source_id) {
                    continue;
                }
            }
            count += 1;
        }
        Ok(count)
    }

    /// `listLatestTakeGrades(filter)`: the newest row of each take whose take and page exist and
    /// whose page is not soft-deleted (`DISTINCT ON (take_id) ... ORDER BY graded_at DESC`), then
    /// the filters, newest first (`graded_at DESC, take_id DESC`), at most `limit` rows. Each row
    /// carries the take's page `source_id` and `slug` read now.
    pub fn list_latest_take_grades(&self, filter: &TakeGradeFilter) -> Result<Vec<Value>> {
        const OP: &str = "listLatestTakeGrades";
        if let Some(v) = &filter.verdict {
            no_nul(OP, &[("verdict", v)])?;
        }
        if filter.limit < 0 {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP}: LIMIT must not be negative"),
            ));
        }
        let min = filter.min_confidence.map(|m| to_real(OP, m)).transpose()?;
        let read = self.read()?;
        let mut newest: BTreeMap<i64, GradeRecord> = BTreeMap::new();
        let mut raw = Vec::new();
        scan_prefix(&*read, &[keys::TAKE, GRADE], false, &mut |_, v| {
            raw.push(v.to_vec());
            true
        })?;
        for bytes in raw {
            let r: GradeRecord = serde_json::from_slice(&bytes)?;
            match newest.get(&r.take_id) {
                Some(cur) if cur.graded_at_us >= r.graded_at_us => {}
                _ => {
                    newest.insert(r.take_id, r);
                }
            }
        }
        let mut rows = Vec::new();
        for (take_id, g) in newest {
            let Ok(id) = u64::try_from(take_id) else {
                continue;
            };
            let Some(take) = read_take(&*read, id)? else {
                continue;
            };
            let Some(page) = read_page_by_id(&*read, take.page_id)? else {
                continue;
            };
            if page.deleted_at_us.is_some() {
                continue;
            }
            if filter.verdict.as_ref().is_some_and(|v| *v != g.verdict)
                || min.is_some_and(|m| g.confidence < m)
                || filter.applied.is_some_and(|a| a != g.applied)
            {
                continue;
            }
            rows.push((g, take, page));
        }
        rows.sort_by(|(a, ..), (b, ..)| {
            b.graded_at_us
                .cmp(&a.graded_at_us)
                .then(b.take_id.cmp(&a.take_id))
        });
        Ok(rows
            .into_iter()
            .take(usize::try_from(filter.limit).unwrap_or(usize::MAX))
            .map(|(g, take, page)| {
                json!({
                    "take_id": g.take_id,
                    "source_id": page.source_id,
                    "page_slug": page.slug,
                    "row_num": take.row_num,
                    "claim": take.claim,
                    "holder": take.holder,
                    "since_date": take.since_date,
                    "verdict": g.verdict,
                    "confidence": real(g.confidence),
                    "applied": g.applied,
                    "judge_model_id": g.judge_model_id,
                    "prompt_version": g.prompt_version,
                    "graded_at": iso(g.graded_at_us),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store as open_store;

    fn key(take_id: i64, sig: &str) -> TakeGradeKey {
        TakeGradeKey {
            take_id,
            prompt_version: "p".into(),
            judge_model_id: "j".into(),
            evidence_signature: sig.into(),
        }
    }

    fn input(take_id: i64, sig: &str, verdict: &str, confidence: f64) -> TakeGradeInput {
        TakeGradeInput {
            take_id,
            prompt_version: "p".into(),
            judge_model_id: "j".into(),
            evidence_signature: sig.into(),
            verdict: verdict.into(),
            confidence,
            applied: false,
            graded_at: Some("2026-01-01T00:00:00Z".into()),
            wave_version: None,
        }
    }

    #[test]
    fn a_cached_verdict_keeps_its_first_row_and_reads_its_real_as_printed() {
        let store = open_store();
        store
            .insert_take_grade(&input(7, "s", "partial", 0.97))
            .unwrap();
        store
            .insert_take_grade(&input(7, "s", "correct", 0.1))
            .unwrap();
        assert_eq!(
            store.read_take_grade(&key(7, "s")).unwrap(),
            Some(json!({ "verdict": "partial", "confidence": 0.97, "applied": false }))
        );
        assert_eq!(store.read_take_grade(&key(7, "t")).unwrap(), None);
        store.delete_take_grade(&key(7, "s")).unwrap();
        assert_eq!(store.read_take_grade(&key(7, "s")).unwrap(), None);
        let bad = store
            .insert_take_grade(&input(7, "s", "maybe", 0.5))
            .unwrap_err();
        assert_eq!(bad.code, CONSTRAINT_VIOLATION);
        let nul = store
            .insert_take_grade(&input(7, "s\0x", "correct", 0.5))
            .unwrap_err();
        assert_eq!(nul.code, INVALID_ARGUMENT);
    }
    #[test]
    fn a_wave_lists_and_unapplies_only_its_applied_verdicts() {
        let store = open_store();
        let row = |take_id, sig: &str, applied, wave: Option<&str>| {
            let mut r = input(take_id, sig, "correct", 0.9);
            r.applied = applied;
            r.wave_version = wave.map(str::to_owned);
            store.insert_take_grade(&r).unwrap();
        };
        row(9, "a", true, Some("w1"));
        row(3, "a", true, Some("w1"));
        row(3, "b", true, Some("w1"));
        row(4, "a", false, Some("w1"));
        row(5, "a", true, None);
        assert_eq!(store.list_wave_applied_take_ids("w1").unwrap(), vec![3, 9]);
        assert_eq!(
            store.list_wave_applied_take_ids(DEFAULT_WAVE).unwrap(),
            vec![5]
        );
        let spec = |dry_run| WaveSpec {
            wave_version: "w1".into(),
            dry_run,
        };
        assert_eq!(store.unapply_wave_take_grades(&spec(true)).unwrap(), 3);
        assert_eq!(store.list_wave_applied_take_ids("w1").unwrap(), vec![3, 9]);
        assert_eq!(store.unapply_wave_take_grades(&spec(false)).unwrap(), 3);
        assert!(store.list_wave_applied_take_ids("w1").unwrap().is_empty());
        assert_eq!(
            store.read_take_grade(&key(9, "a")).unwrap(),
            Some(json!({ "verdict": "correct", "confidence": 0.9, "applied": false }))
        );
        assert_eq!(store.unapply_wave_take_grades(&spec(false)).unwrap(), 0);
    }
}
