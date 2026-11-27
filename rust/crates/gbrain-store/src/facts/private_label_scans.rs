//! The preview scans of `gbrain repair private-labels` (src/core/engine-sql/private-label-scans.ts):
//!
//! - `listLabelledPages`: the live pages a label makes private (`visibility: private`, or no `visibility` and a privacy
//!   alias), with their revision, stored body size and whether their source publishes to Git.
//! - `listLiveLabelRows`: the live rows a restore rereads.
//! - `listClearDependents`: `dependentsSql('clear')`, the pages a window of clears exposes besides themselves. A
//!   candidate is a page of a cleared page's source tied to it the way the remote privacy rules follow privacy: it names
//!   the cleared page in `source_slug`, `event.depth` or `derived_from` (a `derived_from` tie also reaches the events whose
//!   `event.depth` names the tied page), or a concept-provenance link reaches it from the cleared page or from an atom of
//!   it. A candidate is returned when it is private now (`privacyPartSql`) and public once the window applies, judged on
//!   the pages with the window's label keys removed ([`Shadowed`]).
//!
//! Texts compare by bytes; rows come back by id (and cleared id), as the statements order them.

use super::privacy::{alias_private, privacy_allows};
use crate::Store;
use crate::error::Result;
use crate::keys;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::page_body::segmented_body_bytes;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// `listLabelledPages({ sourceIds, after, ids })` and `listLiveLabelRows({ ids })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelScanArgs {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub after: i64,
    #[serde(default)]
    pub ids: Option<Vec<i64>>,
}

/// `listClearDependents({ ids, sourceIds, slugs, keys, honorAliases })`: the cleared pages, column by column.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearDependentsArgs {
    pub ids: Vec<i64>,
    pub source_ids: Vec<String>,
    pub slugs: Vec<String>,
    pub keys: Vec<String>,
    pub honor_aliases: bool,
}

/// The listLabelledPages page size (`LIMIT 5000`).
const SCAN_PAGE: usize = 5000;

fn field(fm: &Map<String, Value>, key: &str) -> Option<String> {
    fm.get(key).and_then(jsonb_field_text)
}

fn label_row(read: &dyn KvRead, page: &PageRecord) -> Result<Value> {
    Ok(
        json!({ "id": page.id, "source_id": page.source_id, "slug": page.slug, "type": page.page_type,
        "frontmatter": crate::jsonb::order_map(page.frontmatter.clone()), "revision": page.knowledge_revision,
        "chars": segmented_body_bytes(read, page.id)?.unwrap_or(0) }),
    )
}

/// A read of the store with the window's label keys removed from the cleared pages' frontmatter: the pages table shadowed
/// as `dependentsSql('clear')` shadows it for the postimage.
struct Shadowed<'a> {
    inner: &'a dyn KvRead,
    /// Page record key -> the record as the window leaves it.
    patched: HashMap<Vec<u8>, Vec<u8>>,
}

impl KvRead for Shadowed<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        match self.patched.get(key) {
            Some(value) => Ok(Some(value.clone())),
            None => self.inner.get(key),
        }
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.inner
            .scan(start, end, reverse, &mut |k, v| match self.patched.get(k) {
                Some(value) => f(k, value),
                None => f(k, v),
            })
    }
}

/// The references a page names (`refs`): its `source_slug`, its `event.depth`, and each `derived_from` slug without `.md`.
fn refs_of(page: &PageRecord) -> Vec<(&'static str, String)> {
    let fm = &page.frontmatter;
    let mut out = Vec::new();
    if let Some(slug) = field(fm, "source_slug") {
        out.push(("source_slug", slug));
    }
    if let Some(depth) = fm
        .get("event")
        .and_then(|e| e.get("depth"))
        .and_then(jsonb_field_text)
    {
        out.push(("depth", depth));
    }
    let declared: Vec<&Value> = match fm.get("derived_from") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(one @ Value::String(_)) => vec![one],
        _ => Vec::new(),
    };
    for item in declared {
        if let Some(slug) = jsonb_field_text(item) {
            out.push((
                "declared",
                slug.strip_suffix(".md").map(str::to_string).unwrap_or(slug),
            ));
        }
    }
    out
}

fn category(page: &PageRecord) -> &'static str {
    let fm = &page.frontmatter;
    if page.page_type == "event"
        && field(fm, "captured_via").is_some_and(|via| via.starts_with("life-chronicle:"))
    {
        "life_chronicle"
    } else if page.page_type == "atom" {
        "atom"
    } else if page.page_type == "concept" && field(fm, "synthesized_by").is_some() {
        "concept"
    } else {
        "derived_from"
    }
}

impl Store {
    /// `listLabelledPages({ sourceIds, after, ids })`: the live pages of the sources with id above `after` (only `ids`
    /// when given) that `visibility: private` or, with no `visibility`, a privacy alias makes private, by id, at most 5000.
    pub fn list_labelled_pages(&self, a: &LabelScanArgs) -> Result<Vec<Value>> {
        let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        let ids: Option<BTreeSet<i64>> = a.ids.as_ref().map(|ids| ids.iter().copied().collect());
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                let visibility = field(&p.frontmatter, "visibility");
                p.deleted_at_us.is_none()
                    && sources.contains(p.source_id.as_str())
                    && (p.id as i64) > a.after
                    && (visibility.as_deref() == Some("private")
                        || (visibility.is_none() && alias_private(&p.frontmatter)))
                    && ids.as_ref().is_none_or(|ids| ids.contains(&(p.id as i64)))
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::new();
        for page in pages.iter().take(SCAN_PAGE) {
            let git = read_source(&*read, &page.source_id)?.is_some_and(|s| {
                s.config
                    .get("canonical")
                    .and_then(jsonb_field_text)
                    .as_deref()
                    == Some("git")
            });
            let mut row = label_row(&*read, page)?;
            row["git"] = json!(git);
            out.push(row);
        }
        Ok(out)
    }

    /// `listLiveLabelRows({ ids })`: the live rows of the named pages, by id.
    pub fn list_live_label_rows(&self, a: &LabelScanArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in a.ids.iter().flatten().copied().collect::<BTreeSet<i64>>() {
            if let Ok(id) = u64::try_from(id)
                && let Some(page) = read_page_by_id(&*read, id)?
                && page.deleted_at_us.is_none()
            {
                out.push(label_row(&*read, &page)?);
            }
        }
        Ok(out)
    }

    /// `listContextualRetrievalModes({ ids })`: `{ id, mode }` of the named pages (any state) stored under a
    /// contextual-retrieval mode, by id.
    pub fn list_contextual_retrieval_modes(&self, a: &LabelScanArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in a.ids.iter().flatten().copied().collect::<BTreeSet<i64>>() {
            if let Ok(id) = u64::try_from(id)
                && read_page_by_id(&*read, id)?.is_some()
                && let Some(mode) = crate::aliases::contextual_retrieval_mode(&*read, id)?
            {
                out.push(json!({ "id": id, "mode": mode }));
            }
        }
        Ok(out)
    }

    /// `listUnembeddedChunkPages({ ids })`: the named pages with a chunk of their live body (`chunkGenerationFilter`)
    /// that has no vector, by id.
    pub fn list_unembedded_chunk_pages(&self, a: &LabelScanArgs) -> Result<Vec<u64>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in a.ids.iter().flatten().copied().collect::<BTreeSet<i64>>() {
            let Ok(id) = u64::try_from(id) else {
                continue;
            };
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if crate::chunks::keyed_chunks(&*read, id, Some(crate::chunks::segmented(&page)))?
                .iter()
                .any(|(_, chunk)| chunk.embed.dims == 0)
            {
                out.push(id);
            }
        }
        Ok(out)
    }

    /// `listClearDependents({ ids, sourceIds, slugs, keys, honorAliases })`: `{ id, cleared_id, category }` for each page
    /// the window's clears expose and each cleared page it is tied to, by (id, cleared id).
    pub fn list_clear_dependents(&self, a: &ClearDependentsArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let cleared: Vec<(u64, &str, &str, Vec<&str>)> = a
            .ids
            .iter()
            .zip(&a.source_ids)
            .zip(&a.slugs)
            .zip(&a.keys)
            .filter_map(|(((id, source), slug), keys)| {
                u64::try_from(*id).ok().map(|id| {
                    (
                        id,
                        source.as_str(),
                        slug.as_str(),
                        keys.split(',').collect(),
                    )
                })
            })
            .collect();
        let cleared_ids: BTreeSet<u64> = cleared.iter().map(|c| c.0).collect();
        let sources: BTreeSet<&str> = cleared.iter().map(|c| c.1).collect();
        let pages: Vec<PageRecord> = all_pages(&*read)?;
        // refs: every page of the cleared sources (deleted or not) and the references it names.
        let refs: Vec<(&PageRecord, &'static str, String)> = pages
            .iter()
            .filter(|p| sources.contains(p.source_id.as_str()))
            .flat_map(|p| refs_of(p).into_iter().map(move |(kind, r)| (p, kind, r)))
            .collect();
        // hits: a reference to a cleared page of the same source.
        let mut hits: Vec<(&PageRecord, &'static str, u64)> = Vec::new();
        for (page, kind, r) in &refs {
            for (cid, source, slug, _) in &cleared {
                if page.source_id == *source && r == slug {
                    hits.push((page, kind, *cid));
                }
            }
        }
        let mut ties: Vec<(u64, u64)> = Vec::new();
        for (page, kind, cid) in &hits {
            if page.deleted_at_us.is_none() {
                ties.push((page.id, *cid));
            }
            if *kind == "declared" {
                for (other, other_kind, r) in &refs {
                    if *other_kind == "depth"
                        && other.source_id == page.source_id
                        && *r == page.slug
                        && other.deleted_at_us.is_none()
                    {
                        ties.push((other.id, *cid));
                    }
                }
            }
        }
        // provenance: concept-provenance links to a cleared page or to an atom tied to one by its source_slug.
        let mut provenance_targets: Vec<(u64, u64, &str)> =
            cleared.iter().map(|c| (c.0, c.0, c.1)).collect();
        for (page, kind, cid) in &hits {
            if *kind == "source_slug" {
                provenance_targets.push((page.id, *cid, page.source_id.as_str()));
            }
        }
        let by_id: HashMap<u64, &PageRecord> = pages.iter().map(|p| (p.id, p)).collect();
        let mut inbound: HashMap<u64, Vec<u64>> = HashMap::new();
        for page in &pages {
            for link in out_links(&*read, page.id)? {
                if link.link_source.as_deref() == Some("concept-provenance")
                    && link.link_type == "synthesized_from"
                {
                    inbound.entry(link.to_page_id).or_default().push(page.id);
                }
            }
        }
        for (target, cid, source) in provenance_targets {
            for from in inbound.get(&target).into_iter().flatten() {
                if let Some(p) = by_id.get(from)
                    && p.source_id == source
                    && p.deleted_at_us.is_none()
                {
                    ties.push((p.id, cid));
                }
            }
        }
        let candidates: BTreeSet<(u64, u64)> = ties
            .into_iter()
            .filter(|(id, _)| !cleared_ids.contains(id))
            .collect();
        // The postimage: each cleared page's record with its label keys removed.
        let mut patched = HashMap::new();
        for (cid, _, _, keys) in &cleared {
            if let Some(page) = by_id.get(cid) {
                let mut after = (*page).clone();
                for key in keys {
                    after.frontmatter.remove(*key);
                }
                patched.insert(
                    keys::page(&page.source_id, &page.slug),
                    serde_json::to_vec(&after)?,
                );
            }
        }
        let shadow = Shadowed {
            inner: &*read,
            patched,
        };
        let mut public_after: BTreeMap<u64, bool> = BTreeMap::new();
        let mut out = Vec::new();
        for (id, cid) in candidates {
            let Some(page) = by_id.get(&id) else {
                continue;
            };
            let after = match public_after.get(&id) {
                Some(after) => *after,
                None => {
                    let shadowed = read_page_by_id(&shadow, id)?
                        .map_or(Ok(false), |p| privacy_allows(&shadow, &p, a.honor_aliases))?;
                    public_after.insert(id, shadowed);
                    shadowed
                }
            };
            if after && !privacy_allows(&*read, page, a.honor_aliases)? {
                out.push(json!({ "id": id, "cleared_id": cid, "category": category(page) }));
            }
        }
        Ok(out)
    }
}
