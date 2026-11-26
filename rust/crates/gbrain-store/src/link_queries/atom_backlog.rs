//! The extract_atoms backlog: `countAtomExtractionBacklog` (src/core/engine-sql/atom-backlog.ts), the one count
//! behind doctor's extract_atoms_backlog, the drain's remaining count, `gbrain dream` and the autopilot dispatch
//! (`countExtractAtomsBacklog`, src/core/cycle/extract-atoms.ts).
//!
//! A page counts when it is live, of an extractable type, has a content hash, is not a greenfield import or a
//! dream-generated page, is not a source page holding a `raw` payload pointer, has a compiled truth of at least
//! `minChars` characters (a segmented page's NULL body never does), is not a connector page of an opted-out
//! connector source, and no live, unmanaged atom of the same source carries its content hash's first 16
//! characters as `source_hash`.
//!
//! A page whose input is held (#10270) is left out too: a held `atom` generation whose hold id is one of the
//! query's `holdIds`, that is not a partial hold, and whose input pin is the page's content hash or
//! `<content hash>:<id>:<knowledge revision>` (`generations::atom_reads::held_atom_inputs`).
//!
//! Two statement exclusions find nothing to read here: the `managed-atoms` checkpoints and the
//! `extract_atoms_page_state` rows (held, tombstoned and partial dispositions). The store has no writer of
//! either, so a page is never excluded by them; `maxInputChars` is accepted for that reason and unused.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::generations::atom_reads::held_atom_inputs;
use crate::pages::{PageRecord, all_pages};
use crate::sources::all_sources;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

/// How many leading characters of a content hash an atom's `source_hash` holds.
const SOURCE_HASH_CHARS: usize = 16;

/// The connector opt-out: the page types left out of sources of these kinds.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorExclusion {
    pub page_types: Vec<String>,
    pub source_kinds: Vec<String>,
}

/// `AtomBacklogQuery`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomBacklogQuery {
    #[serde(default)]
    pub source_id: Option<String>,
    pub types: Vec<String>,
    pub min_chars: usize,
    /// Accepted and unused: it bounds the partial dispositions the store never records.
    #[serde(default)]
    #[allow(dead_code)]
    pub max_input_chars: Option<i64>,
    #[serde(default)]
    pub connector_exclusion: Option<ConnectorExclusion>,
    /// The hold ids of the held atom generations whose input is still current (`currentHoldIds(engine, 'atom')`).
    #[serde(default)]
    pub hold_ids: Vec<String>,
}

/// The first 16 characters of the content hash: `substring(p.content_hash from 1 for 16)`.
fn hash_head(hash: &str) -> String {
    hash.chars().take(SOURCE_HASH_CHARS).collect()
}

/// An atom that already answers a page of its source: live, `source_hash` set, not a managed extraction.
fn is_unmanaged_atom(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none()
        && page.page_type == "atom"
        && fm_text(&page.frontmatter, "managed_extraction").unwrap_or_default() != "true"
}

impl Store {
    /// `countAtomExtractionBacklog(query)`: the live pages awaiting atom extraction in the query's source scope.
    pub fn count_atom_extraction_backlog(&self, query: &AtomBacklogQuery) -> Result<u64> {
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let kinds: BTreeMap<String, Option<String>> = all_sources(&*read)?
            .into_iter()
            .map(|s| (s.id, fm_text(&s.config, "kind")))
            .collect();
        let atoms: BTreeSet<(&str, String)> = pages
            .iter()
            .filter(|p| is_unmanaged_atom(p))
            .filter_map(|p| {
                let hash = fm_text(&p.frontmatter, "source_hash")?;
                Some((p.source_id.as_str(), hash))
            })
            .collect();
        let hold_ids: BTreeSet<&str> = query.hold_ids.iter().map(String::as_str).collect();
        let held = held_atom_inputs(&*read, &hold_ids)?;
        let mut count = 0;
        for page in &pages {
            if query
                .source_id
                .as_deref()
                .is_some_and(|id| page.source_id != id)
                || page.deleted_at_us.is_some()
                || !query.types.contains(&page.page_type)
            {
                continue;
            }
            let Some(hash) = page.content_hash.as_deref() else {
                continue;
            };
            if fm_text(&page.frontmatter, "imported_from").as_deref() == Some("markdown-greenfield")
                || fm_text(&page.frontmatter, "dream_generated").as_deref() == Some("true")
                // A record-tier or private email says `extract_atoms: false` (src/core/google/ingest-tiers.ts).
                || fm_text(&page.frontmatter, "extract_atoms").as_deref() == Some("false")
                || (page.page_type == "source" && page.frontmatter.contains_key("raw"))
            {
                continue;
            }
            let long_enough = page
                .compiled_truth
                .as_deref()
                .is_some_and(|truth| truth.chars().count() >= query.min_chars);
            if !long_enough {
                continue;
            }
            if let Some(connectors) = &query.connector_exclusion {
                let kind = kinds.get(&page.source_id).and_then(Option::as_ref);
                if connectors.page_types.contains(&page.page_type)
                    && kind.is_some_and(|k| connectors.source_kinds.contains(k))
                {
                    continue;
                }
            }
            if atoms.contains(&(page.source_id.as_str(), hash_head(hash))) {
                continue;
            }
            let owner = format!("source_slug:{}", page.slug);
            let current = format!("{hash}:{}:{}", page.id, page.knowledge_revision);
            if [hash, current.as_str()].into_iter().any(|pin| {
                held.contains(&(page.source_id.clone(), owner.clone(), pin.to_string()))
            }) {
                continue;
            }
            count += 1;
        }
        Ok(count)
    }
}
