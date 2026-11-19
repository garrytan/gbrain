//! `listFactProvenance` (src/core/engine-sql/facts-trust.ts): the stored provenance (`facts.source`)
//! of the named facts of one source, which context_pack and delta attach to each fact they deliver
//! (src/core/ops/facts.ts `withProvenance`). It reads the fact rows by id and needs no key range of
//! its own.
//!
//! The TypeScript member (src/core/rust-engine/store-members/facts-provenance.ts) refuses an id that
//! is not a safe integer.

use super::read_fact;
use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listFactProvenance({ sourceId, ids })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactProvenanceQuery {
    pub source_id: String,
    pub ids: Vec<i64>,
}

impl Store {
    /// `listFactProvenance`: `{ id, source }` for each fact of `sourceId` whose id is in `ids`
    /// (`id = ANY(ids)`: a repeated id answers once, an id no row of the source has answers
    /// nothing). The SQL has no `ORDER BY`; the store answers in id order.
    pub fn list_fact_provenance(&self, q: &FactProvenanceQuery) -> Result<Vec<Value>> {
        no_nul("listFactProvenance", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let wanted: BTreeSet<u64> = q
            .ids
            .iter()
            .filter_map(|&id| u64::try_from(id).ok())
            .collect();
        let mut out = Vec::with_capacity(wanted.len());
        for id in wanted {
            let Some(row) = read_fact(&*read, id)? else {
                continue;
            };
            if row.source_id != q.source_id {
                continue;
            }
            out.push(json!({ "id": row.id, "source": row.source }));
        }
        Ok(out)
    }
}
