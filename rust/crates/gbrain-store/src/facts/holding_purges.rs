//! `insertHoldingPagePurges` (src/core/engine-sql/facts-purge.ts): a purge also stores a tombstone under the holding
//! page of each fact the purge removes, when that fact is about an entity with no page of its own (GST-2492).
//!
//! The SQL selects the distinct `source_markdown_slug` of the facts named by `factIds` that are in the source, sit on a
//! holding page (`memory/unattributed` or a slug ending in `/memory/unattributed`) and have an entity, and inserts one
//! `fact_purges` row for each, `ON CONFLICT DO NOTHING`. Here each slug goes through `insert_fact_purge`, so the key,
//! the stored columns and the keep-the-first-row rule are the ledger's own (facts/purge_ledger.rs). An id that names no
//! fact adds nothing. A `NUL` byte in a text argument or a `requestId` that is not a UUID is refused whether or not a
//! row would be added, as Postgres refuses the bound parameter.

use super::bigint;
use super::privacy::holding_slug;
use super::purge_ledger::FactPurgeInsert;
use super::read_fact;
use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use crate::links::no_nul;
use serde::Deserialize;
use std::collections::BTreeSet;

/// `insertHoldingPagePurges(sourceId, visibility, factHash, requestId, actor, reason, factIds)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HoldingPagePurgeArgs {
    pub source_id: String,
    pub visibility: String,
    pub fact_hash: String,
    pub request_id: String,
    pub actor: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub fact_ids: Vec<f64>,
}

impl Store {
    /// Stores a purge tombstone for each holding page that holds one of the facts about an entity with no page of its
    /// own, none twice; how many it added.
    pub fn insert_holding_page_purges(&self, a: &HoldingPagePurgeArgs) -> Result<u64> {
        const OP: &str = "insertHoldingPagePurges";
        no_nul(
            OP,
            &[
                ("sourceId", &a.source_id),
                ("visibility", &a.visibility),
                ("factHash", &a.fact_hash),
                ("requestId", &a.request_id),
                ("actor", &a.actor),
                ("reason", a.reason.as_deref().unwrap_or("")),
            ],
        )?;
        if !is_uuid(&a.request_id) {
            return Err(StoreError::invalid(format!(
                "{OP}: invalid input syntax for type uuid: \"{}\"",
                a.request_id
            )));
        }
        let ids = a
            .fact_ids
            .iter()
            .map(|id| bigint(OP, "factIds", *id))
            .collect::<Result<Vec<i64>>>()?;
        let mut slugs = BTreeSet::new();
        {
            let read = self.read()?;
            for id in ids.into_iter().filter(|id| *id >= 1) {
                let Some(fact) = read_fact(&*read, id as u64)? else {
                    continue;
                };
                let Some(slug) = fact.source_markdown_slug else {
                    continue;
                };
                if fact.source_id == a.source_id
                    && fact.entity_slug.is_some()
                    && holding_slug(&slug)
                {
                    slugs.insert(slug);
                }
            }
        }
        let mut added = 0;
        for subject in slugs {
            let row = FactPurgeInsert {
                source_id: a.source_id.clone(),
                visibility: a.visibility.clone(),
                subject,
                fact_hash: a.fact_hash.clone(),
                request_id: Some(a.request_id.clone()),
                actor: Some(a.actor.clone()),
                reason: a.reason.clone(),
            };
            if self.insert_fact_purge(&row)? {
                added += 1;
            }
        }
        Ok(added)
    }
}
