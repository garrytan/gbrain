//! `listSlotRows` (`engine-sql/facts-recall.ts`), the pool read that ends a slot value a later one replaced
//! (`search/slot-ends.ts` applySlotEnds). It is the first of lane 4's six candidate-pool reads served here (the other
//! five are `readFactsEmbeddingColumn`, `listNearestFacts`, `listPoolUnbackedKeys`, `listCallOffCueFacts` and
//! `listPoolEntityPairs`; rust-5a b7a23fbeba serves all six in this file, so when it lands take its file).
//!
//! The read admits a row exactly as `listFactsForRelevance` does (`facts/trust.rs`, `Pool::admits`): the source, the
//! audit sources, a quarantined provenance page, the visibility and private-provenance policies, a soft-deleted page, the
//! trust floor and the filters; expired rows are included in the read (`includeExpired`).
//!
//! - `listSlotRows`: pool rows that are still active conversation slot rows of the given `(source, entity, dimension)`
//!   slots (unexpired, not superseded, a value hash, `dim_status` active, a conversation source), by `valid_from` then `id`.

use super::trust::{Pool, PoolArgs, pool_row};
use super::{FactRecord, source_rows};
use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

/// A `(source, entity, dimension)` slot.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotKey {
    pub source_id: String,
    pub entity_slug: String,
    pub dimension: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotArgs {
    pub pool: PoolArgs,
    pub slots: Vec<SlotKey>,
}

/// A pool row as `FACT_POOL_COLUMNS` selects it, without the `similarity` column.
fn plain_row(row: &FactRecord) -> Value {
    let mut value = pool_row(row, Value::Null);
    if let Value::Object(map) = &mut value {
        map.remove("similarity");
    }
    value
}

/// The pool's admitted rows over every source of the pool, in source then id order.
fn admitted(store: &Store, op: &str, args: &PoolArgs) -> Result<Vec<FactRecord>> {
    let read = store.read()?;
    let pool = Pool::new(op, args, store.env.now_micros())?;
    let mut out = Vec::new();
    for source in &pool.sources {
        for row in source_rows(&*read, source)? {
            if pool.admits(&*read, &row)? {
                out.push(row);
            }
        }
    }
    Ok(out)
}

impl Store {
    /// `listSlotRows`: the active conversation slot rows of the given slots, `valid_from` then `id`.
    pub fn list_slot_rows(&self, args: &SlotArgs) -> Result<Vec<Value>> {
        const OP: &str = "listSlotRows";
        let mut texts = Vec::new();
        for slot in &args.slots {
            texts.push(("slots", slot.source_id.as_str()));
            texts.push(("slots", slot.entity_slug.as_str()));
            texts.push(("slots", slot.dimension.as_str()));
        }
        no_nul(OP, &texts)?;
        let wanted: BTreeSet<(&str, &str, &str)> = args
            .slots
            .iter()
            .map(|s| {
                (
                    s.source_id.as_str(),
                    s.entity_slug.as_str(),
                    s.dimension.as_str(),
                )
            })
            .collect();
        let mut pool = args.pool.clone();
        pool.include_expired = true;
        let mut rows: Vec<FactRecord> = admitted(self, OP, &pool)?
            .into_iter()
            .filter(|f| {
                f.expired_at_us.is_none()
                    && f.superseded_by.is_none()
                    && f.value_hash.is_some()
                    && f.dim_status.as_deref().unwrap_or("active") == "active"
                    && f.conversation_slot()
                    && matches!((&f.entity_slug, &f.dimension),
                        (Some(entity), Some(dimension))
                            if wanted.contains(&(f.source_id.as_str(), entity.as_str(), dimension.as_str())))
            })
            .collect();
        rows.sort_by(|a, b| a.valid_from_us.cmp(&b.valid_from_us).then(a.id.cmp(&b.id)));
        Ok(rows.iter().map(plain_row).collect())
    }
}
