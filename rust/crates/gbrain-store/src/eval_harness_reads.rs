//! The memory-trust evals' harness reads (src/core/engine-sql/eval-harness-reads.ts): facts by id
//! with their lifecycle, the live facts of a source by exact text, and every page with its id. They
//! are trusted local reads over every source, private rows included, and read the families' own
//! records; this module keeps no keys of its own. rust/docs/store/eval-harness-reads.md lists what
//! differs from the SQL.

use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::eval_harness_catalog::page_heads;
use crate::facts::{for_each_source_fact, read_fact};
use crate::links::no_nul;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

/// `getFactsByIds({ ids })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactsByIdsQuery {
    pub ids: Vec<i64>,
}

/// `findLiveFactsByText({ sourceId, texts })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveFactsByTextQuery {
    pub source_id: String,
    pub texts: Vec<String>,
}

impl Store {
    /// `getFactsByIds`: `{ id, source_id, fact, entity_slug, expired_at, superseded_by }` for each
    /// fact whose id is in `ids`, in any source, by id (`id = ANY(ids) ORDER BY id`: a repeated id
    /// answers once, a missing or negative id answers nothing).
    pub fn get_facts_by_ids(&self, q: &FactsByIdsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<u64> = q
            .ids
            .iter()
            .filter_map(|&id| u64::try_from(id).ok())
            .collect();
        let mut out = Vec::with_capacity(wanted.len());
        for id in wanted {
            if let Some(row) = read_fact(&*read, id)? {
                out.push(json!({
                    "id": row.id, "source_id": row.source_id, "fact": row.fact, "entity_slug": row.entity_slug,
                    "expired_at": row.expired_at_us.map(iso), "superseded_by": row.superseded_by,
                }));
            }
        }
        Ok(out)
    }

    /// `findLiveFactsByText`: `{ id, fact }` for each active fact of `sourceId` (no `expired_at`, not
    /// past its `valid_until`) whose text equals one of `texts` byte for byte, by id. The source's
    /// facts are read one at a time, not all at once.
    pub fn find_live_facts_by_text(&self, q: &LiveFactsByTextQuery) -> Result<Vec<Value>> {
        no_nul("findLiveFactsByText", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let texts: HashSet<&str> = q.texts.iter().map(String::as_str).collect();
        let now = self.env.now_micros();
        let mut rows: Vec<(u64, String)> = Vec::new();
        for_each_source_fact(&*read, &q.source_id, &mut |r| {
            if r.active(now) && texts.contains(r.fact.as_str()) {
                rows.push((r.id, r.fact.clone()));
            }
            true
        })?;
        rows.sort_by_key(|r| r.0);
        Ok(rows
            .iter()
            .map(|(id, fact)| json!({ "id": id, "fact": fact }))
            .collect())
    }

    /// `listPageIdSlugs`: `{ id, slug, source_id, deleted_at }` for every page of every source, a
    /// soft-deleted page included, by id. Only those four fields of each page record are decoded.
    pub fn list_page_id_slugs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = page_heads(&*read)?;
        pages.sort_by_key(|p| p.id);
        Ok(pages
            .iter()
            .map(|p| json!({ "id": p.id, "slug": p.slug, "source_id": p.source_id, "deleted_at": p.deleted_at_us.map(iso) }))
            .collect())
    }
}
