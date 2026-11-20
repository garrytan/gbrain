//! Take horizons: the `take_horizons` table of the PGLite engine, which `gbrain takes horizon` and
//! the forecast journal read and write (`src/core/takes-horizon.ts`, SQL in
//! `src/core/engine-sql/takes-reads.ts`).
//!
//! Members: readTakeClaim, upsertTakeHorizon, deleteTakeHorizon, listTakeHorizons,
//! listHorizonScanRows.
//!
//! Key: `A 0x06 <take id u64 BE>` -> `HorizonRecord` (JSON). The table's primary key is the take id
//! and its foreign key `take_horizons_take_id_fkey` deletes the horizon with its take
//! (`ON DELETE CASCADE`): an upsert for a take that does not exist refuses with that constraint, and
//! `delete_take` (takes.rs) deletes the horizon too. A soft-deleted page keeps its takes, so their
//! horizons stay; only the scan, which joins live pages, skips them.
//!
//! `horizon_date` is a `DATE`, kept as its `YYYY-MM-DD` text (`timeline::parse_date`, the `::date`
//! cast this engine supports); `set_at` is kept in microseconds and crosses as ISO 8601.

use super::*;
use crate::timeline::parse_date;

const HORIZON: u8 = 0x06;
const TABLE: &str = "take_horizons";
const BASES: [&str; 3] = ["stated", "stated_relative", "owner"];

/// `upsertTakeHorizon` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeHorizonInput {
    pub take_id: i64,
    pub claim_sha256: String,
    pub horizon_date: String,
    pub basis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HorizonRecord {
    take_id: u64,
    claim_sha256: String,
    horizon_date: String,
    basis: String,
    set_at_us: i64,
}

pub(super) fn horizon_key(take_id: u64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, HORIZON];
    key.extend_from_slice(&take_id.to_be_bytes());
    key
}

/// A take id as a store id: a negative id names no take.
fn take_id(id: i64) -> Option<u64> {
    u64::try_from(id).ok()
}

fn read_horizon(read: &dyn KvRead, id: u64) -> Result<Option<HorizonRecord>> {
    get_json(read, &horizon_key(id))
}

impl Store {
    /// `readTakeClaim(takeId)`: the take's claim, or `None` when no take has that id.
    pub fn read_take_claim(&self, take_id_value: i64) -> Result<Option<String>> {
        let Some(id) = take_id(take_id_value) else {
            return Ok(None);
        };
        Ok(read_take(&*self.read()?, id)?.map(|t| t.claim))
    }

    /// `upsertTakeHorizon(h)`: sets or replaces the take's horizon, stamped now. The date is cast
    /// first, then the `basis` check, then the foreign key to the take, in the order Postgres checks.
    pub fn upsert_take_horizon(&self, h: &TakeHorizonInput) -> Result<()> {
        const OP: &str = "upsertTakeHorizon";
        no_nul(
            OP,
            &[("claim_sha256", &h.claim_sha256), ("basis", &h.basis)],
        )?;
        let horizon_date = parse_date(&h.horizon_date)?;
        if !BASES.contains(&h.basis.as_str()) {
            return Err(check_failed(TABLE, "take_horizons_basis_check"));
        }
        let Some(id) = take_id(h.take_id) else {
            return Err(fk_failed(TABLE, "take_horizons_take_id_fkey"));
        };
        self.write(|tx| {
            if read_take(&*tx, id)?.is_none() {
                return Err(fk_failed(TABLE, "take_horizons_take_id_fkey"));
            }
            let record = HorizonRecord {
                take_id: id,
                claim_sha256: h.claim_sha256.clone(),
                horizon_date: horizon_date.clone(),
                basis: h.basis.clone(),
                set_at_us: self.env.now_micros(),
            };
            put_json(tx, &horizon_key(id), &record)
        })
    }

    /// `deleteTakeHorizon(takeId)`: removes the take's horizon; `true` when it had one.
    pub fn delete_take_horizon(&self, take_id_value: i64) -> Result<bool> {
        let Some(id) = take_id(take_id_value) else {
            return Ok(false);
        };
        self.write(|tx| {
            let key = horizon_key(id);
            if tx.get(&key)?.is_none() {
                return Ok(false);
            }
            tx.delete(&key)?;
            Ok(true)
        })
    }

    /// `listTakeHorizons(takeIds)`: the horizons of those takes (`None`: of every take) whose take
    /// exists, by take id, each with its take's claim read now.
    pub fn list_take_horizons(&self, take_ids: Option<&[i64]>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut records: Vec<HorizonRecord> = Vec::new();
        match take_ids {
            Some(ids) => {
                let wanted: BTreeSet<u64> = ids.iter().filter_map(|&i| take_id(i)).collect();
                for id in wanted {
                    if let Some(r) = read_horizon(&*read, id)? {
                        records.push(r);
                    }
                }
            }
            None => {
                let mut raw = Vec::new();
                scan_prefix(&*read, &[keys::TAKE, HORIZON], false, &mut |_, v| {
                    raw.push(v.to_vec());
                    true
                })?;
                for bytes in raw {
                    records.push(serde_json::from_slice(&bytes)?);
                }
            }
        }
        let mut rows = Vec::with_capacity(records.len());
        for r in records {
            let Some(take) = read_take(&*read, r.take_id)? else {
                continue;
            };
            rows.push(json!({
                "take_id": r.take_id,
                "horizon_date": r.horizon_date,
                "basis": r.basis,
                "set_at": iso(r.set_at_us),
                "claim_sha256": r.claim_sha256,
                "claim": take.claim,
            }));
        }
        Ok(rows)
    }

    /// `listHorizonScanRows(sourceId)`: every take on a live page (of that source, read now from the
    /// page; `None`: of every source), by take id, with its horizon's fields or nulls.
    pub fn list_horizon_scan_rows(&self, source_id: Option<&str>) -> Result<Vec<Value>> {
        if let Some(s) = source_id {
            no_nul("listHorizonScanRows", &[("sourceId", s)])?;
        }
        let read = self.read()?;
        let mut pages: HashMap<u64, Option<PageRecord>> = HashMap::new();
        let mut rows = Vec::new();
        for take in all_takes(&*read)? {
            let page = match pages.get(&take.page_id) {
                Some(p) => p.clone(),
                None => {
                    let p = read_page_by_id(&*read, take.page_id)?;
                    pages.insert(take.page_id, p.clone());
                    p
                }
            };
            let Some(page) = page else {
                continue;
            };
            if page.deleted_at_us.is_some() || source_id.is_some_and(|s| page.source_id != s) {
                continue;
            }
            let h = read_horizon(&*read, take.id)?;
            rows.push(json!({
                "id": take.id,
                "claim": take.claim,
                "since_date": take.since_date,
                "basis": h.as_ref().map(|h| h.basis.clone()),
                "claim_sha256": h.as_ref().map(|h| h.claim_sha256.clone()),
                "horizon_date": h.as_ref().map(|h| h.horizon_date.clone()),
            }));
        }
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store as open_store;

    fn input(take_id: i64, date: &str, basis: &str) -> TakeHorizonInput {
        TakeHorizonInput {
            take_id,
            claim_sha256: "sha".into(),
            horizon_date: date.into(),
            basis: basis.into(),
        }
    }

    #[test]
    fn a_horizon_needs_its_take_a_known_basis_and_a_date() {
        let store = open_store();
        let missing = store
            .upsert_take_horizon(&input(42, "2027-12-31", "owner"))
            .unwrap_err();
        assert_eq!(missing.code, CONSTRAINT_VIOLATION);
        assert!(missing.message.contains("take_horizons_take_id_fkey"));
        let basis = store
            .upsert_take_horizon(&input(42, "2027-12-31", "guess"))
            .unwrap_err();
        assert!(basis.message.contains("take_horizons_basis_check"));
        let date = store
            .upsert_take_horizon(&input(42, "soon", "owner"))
            .unwrap_err();
        assert!(date.message.contains("invalid input syntax for type date"));
        assert!(!store.delete_take_horizon(42).unwrap());
        assert_eq!(store.list_take_horizons(None).unwrap(), Vec::<Value>::new());
        assert_eq!(store.read_take_claim(42).unwrap(), None);
        assert_eq!(store.read_take_claim(-1).unwrap(), None);
    }
}
