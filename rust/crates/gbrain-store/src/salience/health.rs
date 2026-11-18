//! Salience: the counts behind the doctor's `salience_health` check, as one member,
//! `countZeroWeightWithTakes` (`src/core/engine-sql/salience.ts`).

use super::*;

impl Store {
    /// `countZeroWeightWithTakes()`: `{ zero_weight_with_takes, nonzero_weight }`, the pages with
    /// an active take and an emotional weight of 0 (a page that was never weighed reads 0), and
    /// the pages whose weight is above 0. Soft-deleted pages count.
    pub fn count_zero_weight_with_takes(&self) -> Result<Value> {
        let read = self.read()?;
        let mut with_takes = BTreeSet::new();
        for take in all_takes(&*read)? {
            if take.active {
                with_takes.insert(take.page_id);
            }
        }
        let mut zero = 0_u64;
        for page_id in with_takes {
            if weight_of(record(&*read, page_id)?) == 0.0 {
                zero += 1;
            }
        }
        let mut weighed = 0_u64;
        let mut failure = None;
        scan_prefix(&*read, &[keys::SALIENCE], false, &mut |_, v| {
            match serde_json::from_slice::<SalienceRecord>(v) {
                Ok(rec) => weighed += u64::from(rec.emotional_weight > 0.0),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        Ok(json!({ "zero_weight_with_takes": zero, "nonzero_weight": weighed }))
    }
}
