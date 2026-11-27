//! The extract_atoms phase's page reads (src/core/engine-sql/extract-atoms-reads.ts): `listExtractablePages`
//! (page discovery), `listAtomSourceHashes` (the transcript idempotency read) and `listSourcePageAtomTitles` (the
//! atom-title read of a source page).
//!
//! Discovery keeps the backlog count's predicate (`atom_backlog.rs`): a live page of the source, of an extractable
//! type, with a content hash, not a greenfield import or a dream-generated page, not a source page holding a `raw`
//! payload pointer, opted in (`extract_atoms` is not `false`), with a compiled truth of at least `minChars`
//! characters, not a connector page of an opted-out connector source, and no live, unmanaged atom of the source
//! carrying its content hash's first 16 characters as `source_hash`. It also skips a page whose current content has
//! a completed or held `managed-atoms` checkpoint, which the store does keep, and a page whose current input is held
//! (#10270, the same rule the backlog count applies: `generations::atom_reads::held_atom_inputs`). The `extract_atoms_page_state`
//! exclusion finds nothing here: the store keeps no page state (`assertAtomStateStore` refuses before a run could
//! write any). Rows come newest first (`ORDER BY p.updated_at DESC`), at most `limit`, optionally only of the named
//! slugs.

use super::atom_backlog::ConnectorExclusion;
use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::generations::atom_reads::held_atom_inputs;
use crate::pages::{PageRecord, all_pages};
use crate::persistence::managed_atom_discovery_skips_in;
use crate::sources::all_sources;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// How many leading characters of a content hash an atom's `source_hash` holds.
const SOURCE_HASH_CHARS: usize = 16;

/// `ExtractablePageQuery`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractablePageQuery {
    pub source_id: String,
    pub types: Vec<String>,
    pub min_chars: usize,
    pub limit: usize,
    #[serde(default)]
    pub affected_slugs: Option<Vec<String>>,
    #[serde(default)]
    pub connector_exclusion: Option<ConnectorExclusion>,
    /// The hold ids of the held atom generations whose input is still current (`currentHoldIds(engine, 'atom')`).
    #[serde(default)]
    pub hold_ids: Vec<String>,
}

fn hash_head(hash: &str) -> String {
    hash.chars().take(SOURCE_HASH_CHARS).collect()
}

/// A live atom of any kind: `type = 'atom' AND deleted_at IS NULL`.
fn live_atom(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none() && page.page_type == "atom"
}

/// A live atom that is not a managed extraction.
fn unmanaged_atom(page: &PageRecord) -> bool {
    live_atom(page)
        && fm_text(&page.frontmatter, "managed_extraction").unwrap_or_default() != "true"
}

impl Store {
    /// `listExtractablePages(query)`: `{ id, knowledge_revision, source_incarnation, slug, compiled_truth,
    /// content_hash }` per page.
    pub fn list_extractable_pages(&self, query: &ExtractablePageQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let sources: BTreeMap<String, (String, Option<String>)> = all_sources(&*read)?
            .into_iter()
            .map(|s| {
                let kind = fm_text(&s.config, "kind");
                (s.id, (s.incarnation, kind))
            })
            .collect();
        let skips = managed_atom_discovery_skips_in(&*read)?;
        let hold_ids: BTreeSet<&str> = query.hold_ids.iter().map(String::as_str).collect();
        let held = held_atom_inputs(&*read, &hold_ids)?;
        let atoms: BTreeSet<String> = pages
            .iter()
            .filter(|p| p.source_id == query.source_id && unmanaged_atom(p))
            .filter_map(|p| fm_text(&p.frontmatter, "source_hash"))
            .collect();
        let slugs: Option<BTreeSet<&str>> = query
            .affected_slugs
            .as_ref()
            .filter(|s| !s.is_empty())
            .map(|s| s.iter().map(String::as_str).collect());
        let Some((incarnation, kind)) = sources.get(&query.source_id) else {
            return Ok(Vec::new());
        };
        let mut found: Vec<&PageRecord> = Vec::new();
        for page in &pages {
            if page.source_id != query.source_id
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
            if skips.contains(&(
                page.source_id.clone(),
                incarnation.clone(),
                page.id.to_string(),
                hash.to_string(),
            )) {
                continue;
            }
            if let Some(connectors) = &query.connector_exclusion
                && connectors.page_types.contains(&page.page_type)
                && kind
                    .as_ref()
                    .is_some_and(|k| connectors.source_kinds.contains(k))
            {
                continue;
            }
            // `heldAtomInputExclusionSql`: a held atom generation for the page's current input (#10270).
            let owner = format!("source_slug:{}", page.slug);
            let current = format!("{hash}:{}:{}", page.id, page.knowledge_revision);
            if [hash, current.as_str()]
                .into_iter()
                .any(|pin| held.contains(&(page.source_id.clone(), owner.clone(), pin.to_string())))
            {
                continue;
            }
            if slugs
                .as_ref()
                .is_some_and(|s| !s.contains(page.slug.as_str()))
            {
                continue;
            }
            if atoms.contains(&hash_head(hash)) {
                continue;
            }
            found.push(page);
        }
        found.sort_by_key(|p| std::cmp::Reverse(p.updated_at_us));
        Ok(found
            .into_iter()
            .take(query.limit)
            .map(|page| {
                json!({
                    "id": page.id,
                    "knowledge_revision": page.knowledge_revision,
                    "source_incarnation": incarnation,
                    "slug": page.slug,
                    "compiled_truth": page.compiled_truth.as_deref(),
                    "content_hash": page.content_hash,
                })
            })
            .collect())
    }

    /// `listAtomSourceHashes(sourceId, hashes)`: the `source_hash` of each live, unmanaged atom of the source that is
    /// one of `hashes`, one per atom.
    pub fn list_atom_source_hashes(
        &self,
        source_id: &str,
        hashes: &[String],
    ) -> Result<Vec<String>> {
        let wanted: BTreeSet<&str> = hashes.iter().map(String::as_str).collect();
        Ok(all_pages(&*self.read()?)?
            .iter()
            .filter(|p| p.source_id == source_id && unmanaged_atom(p))
            .filter_map(|p| fm_text(&p.frontmatter, "source_hash"))
            .filter(|h| wanted.contains(h.as_str()))
            .collect())
    }

    /// `listSourcePageAtomTitles(sourceId, sourceSlug)`: `{ slug, title }` of each live atom of the source whose
    /// `source_slug` is the page's slug.
    pub fn list_source_page_atom_titles(
        &self,
        source_id: &str,
        source_slug: &str,
    ) -> Result<Vec<Value>> {
        Ok(all_pages(&*self.read()?)?
            .iter()
            .filter(|p| {
                p.source_id == source_id
                    && live_atom(p)
                    && fm_text(&p.frontmatter, "source_slug").as_deref() == Some(source_slug)
            })
            .map(|p| json!({ "slug": p.slug, "title": p.title }))
            .collect())
    }
}
