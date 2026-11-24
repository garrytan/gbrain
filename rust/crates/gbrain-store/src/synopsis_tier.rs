//! The synopsis tier's configuration read, `readSynopsisTierSources` of
//! `src/core/engine-sql/synopsis-tier.ts` (rust/docs/store/synopsis-tier.md).

use crate::Store;
use crate::error::Result;
use crate::pages::all_pages;
use crate::source_cr_mode::source_modes;
use crate::sources::all_sources;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The frontmatter key and value that pick the synopsis tier for one page
/// (`p.frontmatter @> '{"contextual_retrieval":"per_chunk_synopsis"}'`).
const FRONTMATTER_KEY: &str = "contextual_retrieval";
const SYNOPSIS_MODE: &str = "per_chunk_synopsis";
/// The host source, whose page frontmatter is always trusted.
const HOST_SOURCE: &str = "default";

/// `readSynopsisTierSources`' input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynopsisTierQuery {
    /// True when the kill switch is on or the global tier already is the synopsis tier: the
    /// page check is skipped.
    pub skip_frontmatter: bool,
}

impl Store {
    /// `readSynopsisTierSources({ skipFrontmatter })`: `{ sourceIds, frontmatterPicks }`.
    ///
    /// `sourceIds` lists the sources that are not archived and whose own mode
    /// (`source_cr_mode.rs`) is per_chunk_synopsis, by id in byte order. `frontmatterPicks`
    /// is true when a live markdown page whose source is not archived (a page with no source row
    /// counts as not archived, as the SQL's `LEFT JOIN` does) has the frontmatter value
    /// `contextual_retrieval: per_chunk_synopsis` as a JSON string, and its frontmatter is trusted:
    /// it is on the host source (the store keeps no `trust_frontmatter_overrides`, so no other
    /// source trusts it).
    pub fn read_synopsis_tier_sources(&self, q: &SynopsisTierQuery) -> Result<Value> {
        let read = self.read()?;
        let source_ids: Vec<String> = source_modes(&*read)?
            .into_iter()
            .filter(|(_, (mode, archived))| mode == SYNOPSIS_MODE && !archived)
            .map(|(id, _)| id)
            .collect();
        if q.skip_frontmatter {
            return Ok(json!({ "sourceIds": source_ids, "frontmatterPicks": false }));
        }
        let archived: BTreeMap<String, bool> = all_sources(&*read)?
            .into_iter()
            .map(|s| (s.id, s.archived))
            .collect();
        let picks = all_pages(&*read)?.iter().any(|p| {
            p.deleted_at_us.is_none()
                && p.page_kind == "markdown"
                && !archived.get(&p.source_id).copied().unwrap_or(false)
                && p.source_id == HOST_SOURCE
                && p.frontmatter.get(FRONTMATTER_KEY).and_then(Value::as_str) == Some(SYNOPSIS_MODE)
        });
        Ok(json!({ "sourceIds": source_ids, "frontmatterPicks": picks }))
    }
}
