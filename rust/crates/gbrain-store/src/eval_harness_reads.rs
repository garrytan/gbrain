//! The memory-trust evals' harness reads (src/core/engine-sql/eval-harness-reads.ts): facts by id
//! with their lifecycle, the live facts of a source by exact text, and every page with its id. They
//! are trusted local reads over every source, private rows included, and read the families' own
//! records; this module keeps no keys of its own. rust/docs/store/eval-harness-reads.md lists what
//! differs from the SQL.

use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{read_fact, source_rows};
use crate::links::no_nul;
use crate::pages::all_pages;
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

    /// `findLiveFactsByText`: `{ id, fact }` for each fact of `sourceId` with no `expired_at` whose
    /// text equals one of `texts` byte for byte, by id.
    pub fn find_live_facts_by_text(&self, q: &LiveFactsByTextQuery) -> Result<Vec<Value>> {
        no_nul("findLiveFactsByText", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let texts: HashSet<&str> = q.texts.iter().map(String::as_str).collect();
        let mut rows: Vec<_> = source_rows(&*read, &q.source_id)?
            .into_iter()
            .filter(|r| r.expired_at_us.is_none() && texts.contains(r.fact.as_str()))
            .collect();
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .iter()
            .map(|r| json!({ "id": r.id, "fact": r.fact }))
            .collect())
    }

    /// `listPageIdSlugs`: `{ id, slug, source_id, deleted_at }` for every page of every source, a
    /// soft-deleted page included, by id.
    pub fn list_page_id_slugs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = all_pages(&*read)?;
        pages.sort_by_key(|p| p.id);
        Ok(pages
            .iter()
            .map(|p| json!({ "id": p.id, "slug": p.slug, "source_id": p.source_id, "deleted_at": p.deleted_at_us.map(iso) }))
            .collect())
    }
}
