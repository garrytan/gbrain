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
//! The statement's two disposition exclusions: a page whose current content has a completed or held
//! `managed-atoms` checkpoint (whose `partial`, when set, is at or above `maxInputChars`), and a page whose
//! `extract_atoms_page_state` row for its current content (`atom_state.rs`) is tombstoned or records a partial cap at or
//! above `maxInputChars`.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages};
use crate::persistence::managed_atom_discovery_skips_in;
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
    /// The current input cap: a partial disposition recorded below it counts (it is released on the next run).
    #[serde(default)]
    pub max_input_chars: Option<i64>,
    #[serde(default)]
    pub connector_exclusion: Option<ConnectorExclusion>,
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

/// The `managed-atoms` page checkpoints that skip a page: `(sourceId, incarnation, pageId, contentHash)` with the
/// checkpoint's `partial`, as text (`managed_atom_discovery_skips_in` keeps completed and held ones).
type ManagedSkips = crate::persistence::ManagedAtomSkips;

fn managed_atom_skips(read: &dyn KvRead) -> Result<ManagedSkips> {
    managed_atom_discovery_skips_in(read)
}

/// The backlog's two disposition exclusions for one page at its current content (module docs).
fn settled_for_backlog(
    skips: &ManagedSkips,
    read: &dyn KvRead,
    source_id: &str,
    incarnation: &str,
    page_id: u64,
    hash: &str,
    max_input_chars: Option<i64>,
) -> Result<bool> {
    let at_cap = |partial: i64| max_input_chars.is_none_or(|cap| partial >= cap);
    let key = (
        source_id.to_owned(),
        incarnation.to_owned(),
        page_id.to_string(),
        hash.to_owned(),
    );
    if let Some(partial) = skips.get(&key) {
        match partial {
            None => return Ok(true),
            Some(text) => {
                let value: i64 = text.trim().parse::<i32>().map(i64::from).map_err(|_| {
                    crate::error::StoreError::invalid(format!(
                        "invalid input syntax for type integer: \"{text}\""
                    ))
                })?;
                if at_cap(value) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(
        crate::atom_state::page_state(read, incarnation, page_id, hash)?.is_some_and(|row| {
            row.tombstoned
                || row
                    .partial_input_chars
                    .is_some_and(|p| at_cap(i64::from(p)))
        }),
    )
}

impl Store {
    /// `countAtomExtractionBacklog(query)`: the live pages awaiting atom extraction in the query's source scope.
    pub fn count_atom_extraction_backlog(&self, query: &AtomBacklogQuery) -> Result<u64> {
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let sources = all_sources(&*read)?;
        let incarnations: BTreeMap<String, String> = sources
            .iter()
            .map(|s| (s.id.clone(), s.incarnation.clone()))
            .collect();
        let kinds: BTreeMap<String, Option<String>> = sources
            .into_iter()
            .map(|s| (s.id, fm_text(&s.config, "kind")))
            .collect();
        let skips = managed_atom_skips(&*read)?;
        let atoms: BTreeSet<(&str, String)> = pages
            .iter()
            .filter(|p| is_unmanaged_atom(p))
            .filter_map(|p| {
                let hash = fm_text(&p.frontmatter, "source_hash")?;
                Some((p.source_id.as_str(), hash))
            })
            .collect();
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
            if let Some(incarnation) = incarnations.get(&page.source_id)
                && settled_for_backlog(
                    &skips,
                    &*read,
                    &page.source_id,
                    incarnation,
                    page.id,
                    hash,
                    query.max_input_chars,
                )?
            {
                continue;
            }
            count += 1;
        }
        Ok(count)
    }
}
