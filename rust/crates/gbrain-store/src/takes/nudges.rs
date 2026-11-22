//! The take nudge log: the `take_nudge_log` table of the PGLite engine, one row per nudge fired at a
//! take or a take proposal. `gbrain calibration --undo-wave` deletes a wave's rows
//! (`src/core/calibration/undo-wave.ts`, SQL in `src/core/engine-sql/takes-reads.ts`).
//!
//! Members: insertTakeNudge, listTakeNudges, purgeTakeNudgesByWave.
//!
//! Key: `A 0x07 <nudge id u64 BE>` -> `NudgeRecord` (JSON). Id counter: `M next_take_nudge_id`, taken
//! before the row's checks as the `BIGSERIAL` default is. The table's checks, in Postgres's order:
//! `take_nudge_log_target_xor` (exactly one of take and proposal), then the foreign keys
//! `take_nudge_log_source_id_fkey` and `take_nudge_log_proposal_id_fkey`: a nudge at a proposal needs
//! the proposal (`takes/proposals.rs`, `A 0x08`), and deleting the proposal deletes its nudges
//! (`ON DELETE CASCADE`, [`remove_proposal_rows`]). `take_id` has no foreign key: a row outlives its
//! take. A deleted source deletes its rows (`ON DELETE CASCADE`, [`remove_source_rows`]).

use super::*;
use crate::sources::read_source;
use crate::telemetry::parse_timestamp;

const NUDGE: u8 = 0x07;
const TABLE: &str = "take_nudge_log";
const NEXT_NUDGE_ID: &str = "next_take_nudge_id";
const DEFAULT_CHANNEL: &str = "stderr";
const DEFAULT_WAVE: &str = "v0.36.1.0";

/// `insertTakeNudge` input: channel, wave and time take the column defaults when absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeNudgeInput {
    pub source_id: String,
    #[serde(default)]
    pub take_id: Option<i64>,
    #[serde(default)]
    pub proposal_id: Option<i64>,
    pub nudge_pattern: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub wave_version: Option<String>,
    #[serde(default)]
    pub fired_at: Option<String>,
}

/// `listTakeNudges` filter: a source's nudges, narrowed to whichever of the other fields are set.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeNudgeFilter {
    pub source_id: String,
    #[serde(default)]
    pub take_id: Option<i64>,
    #[serde(default)]
    pub proposal_id: Option<i64>,
    #[serde(default)]
    pub nudge_pattern: Option<String>,
    #[serde(default)]
    pub wave_version: Option<String>,
}

/// A wave and whether the call only counts: `purgeTakeNudgesByWave` and `unapplyWaveTakeGrades`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaveSpec {
    pub wave_version: String,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NudgeRecord {
    id: u64,
    source_id: String,
    take_id: Option<i64>,
    proposal_id: Option<i64>,
    nudge_pattern: String,
    fired_at_us: i64,
    channel: String,
    wave_version: String,
}

fn nudge_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, NUDGE];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn all_nudges(read: &dyn KvRead) -> Result<Vec<NudgeRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::TAKE, NUDGE], false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// A source delete's cascade (`take_nudge_log_source_id_fkey ... ON DELETE CASCADE`): deletes every
/// nudge row of `source_id`.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for record in all_nudges(&*tx)? {
        if record.source_id == source_id {
            tx.delete(&nudge_key(record.id))?;
        }
    }
    Ok(())
}

/// A proposal delete's cascade (`take_nudge_log_proposal_id_fkey ... ON DELETE CASCADE`): deletes
/// every nudge at proposal `proposal_id`.
pub(super) fn remove_proposal_rows(tx: &mut dyn KvWrite, proposal_id: i64) -> Result<()> {
    for record in all_nudges(&*tx)? {
        if record.proposal_id == Some(proposal_id) {
            tx.delete(&nudge_key(record.id))?;
        }
    }
    Ok(())
}

impl Store {
    /// `insertTakeNudge(n)`: logs the nudge and returns its id.
    pub fn insert_take_nudge(&self, n: &TakeNudgeInput) -> Result<u64> {
        const OP: &str = "insertTakeNudge";
        let mut texts = vec![
            ("source_id", n.source_id.as_str()),
            ("nudge_pattern", n.nudge_pattern.as_str()),
        ];
        if let Some(c) = &n.channel {
            texts.push(("channel", c));
        }
        if let Some(w) = &n.wave_version {
            texts.push(("wave_version", w));
        }
        no_nul(OP, &texts)?;
        let fired_at = n
            .fired_at
            .as_deref()
            .map(|t| parse_timestamp(OP, t))
            .transpose()?;
        self.write(|tx| {
            let id = next_id(tx, NEXT_NUDGE_ID)?;
            if n.take_id.is_some() == n.proposal_id.is_some() {
                return Err(check_failed(TABLE, "take_nudge_log_target_xor"));
            }
            if read_source(&*tx, &n.source_id)?.is_none() {
                return Err(fk_failed(TABLE, "take_nudge_log_source_id_fkey"));
            }
            if let Some(proposal) = n.proposal_id
                && !super::proposals::proposal_exists(&*tx, proposal)?
            {
                return Err(fk_failed(TABLE, "take_nudge_log_proposal_id_fkey"));
            }
            let record = NudgeRecord {
                id,
                source_id: n.source_id.clone(),
                take_id: n.take_id,
                proposal_id: n.proposal_id,
                nudge_pattern: n.nudge_pattern.clone(),
                fired_at_us: fired_at.unwrap_or_else(|| self.env.now_micros()),
                channel: n
                    .channel
                    .clone()
                    .unwrap_or_else(|| DEFAULT_CHANNEL.to_string()),
                wave_version: n
                    .wave_version
                    .clone()
                    .unwrap_or_else(|| DEFAULT_WAVE.to_string()),
            };
            put_json(tx, &nudge_key(id), &record)?;
            Ok(id)
        })
    }

    /// `listTakeNudges(filter)`: the source's nudge rows, oldest first (`ORDER BY id`), narrowed to the
    /// take, proposal, pattern and wave the filter sets. `fired_at` crosses as ISO 8601. It is the
    /// confirming read of `insertTakeNudge` on the owner socket.
    pub fn list_take_nudges(&self, f: &TakeNudgeFilter) -> Result<Vec<serde_json::Value>> {
        const OP: &str = "listTakeNudges";
        let mut texts = vec![("source_id", f.source_id.as_str())];
        if let Some(p) = &f.nudge_pattern {
            texts.push(("nudge_pattern", p));
        }
        if let Some(w) = &f.wave_version {
            texts.push(("wave_version", w));
        }
        no_nul(OP, &texts)?;
        Ok(all_nudges(&*self.read()?)?
            .into_iter()
            .filter(|r| {
                r.source_id == f.source_id
                    && f.take_id.is_none_or(|t| r.take_id == Some(t))
                    && f.proposal_id.is_none_or(|p| r.proposal_id == Some(p))
                    && f.nudge_pattern
                        .as_ref()
                        .is_none_or(|p| &r.nudge_pattern == p)
                    && f.wave_version.as_ref().is_none_or(|w| &r.wave_version == w)
            })
            .map(|r| {
                serde_json::json!({
                    "id": r.id,
                    "source_id": r.source_id,
                    "take_id": r.take_id,
                    "proposal_id": r.proposal_id,
                    "nudge_pattern": r.nudge_pattern,
                    "fired_at": crate::env::iso(r.fired_at_us),
                    "channel": r.channel,
                    "wave_version": r.wave_version,
                })
            })
            .collect())
    }

    /// `purgeTakeNudgesByWave(spec)`: the number of the wave's nudge rows; deletes them unless a dry
    /// run.
    pub fn purge_take_nudges_by_wave(&self, spec: &WaveSpec) -> Result<u64> {
        no_nul(
            "purgeTakeNudgesByWave",
            &[("wave_version", &spec.wave_version)],
        )?;
        let matching = |read: &dyn KvRead| -> Result<Vec<u64>> {
            Ok(all_nudges(read)?
                .into_iter()
                .filter(|r| r.wave_version == spec.wave_version)
                .map(|r| r.id)
                .collect())
        };
        if spec.dry_run {
            return Ok(matching(&*self.read()?)?.len() as u64);
        }
        self.write(|tx| {
            let ids = matching(&*tx)?;
            for id in &ids {
                tx.delete(&nudge_key(*id))?;
            }
            Ok(ids.len() as u64)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store as open_store;

    fn nudge(source: &str, take: Option<i64>, proposal: Option<i64>, wave: &str) -> TakeNudgeInput {
        TakeNudgeInput {
            source_id: source.into(),
            take_id: take,
            proposal_id: proposal,
            nudge_pattern: "p".into(),
            channel: None,
            wave_version: Some(wave.into()),
            fired_at: None,
        }
    }

    #[test]
    fn a_nudge_names_one_target_in_a_source_and_a_wave_purge_counts_then_deletes() {
        let store = open_store();
        let a = store
            .insert_take_nudge(&nudge("default", Some(7), None, "w1"))
            .unwrap();
        let b = store
            .insert_take_nudge(&nudge("default", Some(8), None, "w1"))
            .unwrap();
        assert!(b > a);
        store
            .insert_take_nudge(&nudge("default", Some(9), None, "w2"))
            .unwrap();
        let xor = store
            .insert_take_nudge(&nudge("default", None, None, "w1"))
            .unwrap_err();
        assert!(xor.message.contains("take_nudge_log_target_xor"));
        let both = store
            .insert_take_nudge(&nudge("default", Some(1), Some(1), "w1"))
            .unwrap_err();
        assert!(both.message.contains("take_nudge_log_target_xor"));
        let source = store
            .insert_take_nudge(&nudge("nope", Some(1), None, "w1"))
            .unwrap_err();
        assert!(source.message.contains("take_nudge_log_source_id_fkey"));
        let proposal = store
            .insert_take_nudge(&nudge("default", None, Some(1), "w1"))
            .unwrap_err();
        assert!(proposal.message.contains("take_nudge_log_proposal_id_fkey"));
        let filter = |take: Option<i64>, wave: Option<&str>| TakeNudgeFilter {
            source_id: "default".into(),
            take_id: take,
            proposal_id: None,
            nudge_pattern: None,
            wave_version: wave.map(str::to_string),
        };
        let ids = |rows: Vec<serde_json::Value>| -> Vec<u64> {
            rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
        };
        assert_eq!(
            ids(store.list_take_nudges(&filter(None, None)).unwrap()),
            vec![a, b, a + 2]
        );
        assert_eq!(
            ids(store.list_take_nudges(&filter(Some(8), None)).unwrap()),
            vec![b]
        );
        assert_eq!(
            ids(store.list_take_nudges(&filter(None, Some("w2"))).unwrap()),
            vec![a + 2]
        );
        let other = TakeNudgeFilter {
            source_id: "nope".into(),
            ..filter(None, None)
        };
        assert!(store.list_take_nudges(&other).unwrap().is_empty());
        let spec = |dry_run| WaveSpec {
            wave_version: "w1".into(),
            dry_run,
        };
        assert_eq!(store.purge_take_nudges_by_wave(&spec(true)).unwrap(), 2);
        assert_eq!(store.purge_take_nudges_by_wave(&spec(false)).unwrap(), 2);
        assert_eq!(store.purge_take_nudges_by_wave(&spec(true)).unwrap(), 0);
        store.write(|tx| remove_source_rows(tx, "default")).unwrap();
        assert!(all_nudges(&*store.read().unwrap()).unwrap().is_empty());
    }
}
