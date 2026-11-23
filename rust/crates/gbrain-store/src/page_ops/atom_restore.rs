//! The reads of `gbrain repair atoms-restore` (src/core/engine-sql/atom-restore-reads.ts): the re-extraction
//! retirements of `atomRetirementsSql` (`src/core/persistence/atom-retirement-hold.ts`) as rows.
//!
//! - `listRestorableAtoms(sourceIds, atomId)`: each restorable retirement of the sources, by id, with its source
//!   incarnation, revision, origin, hash, `retired_at` text and the newest live version that holds its hash unstamped.
//!   With `atomId`, only that atom: the SQL narrows its scope to the atom's source and origin, which leaves the atom's
//!   own origin group, and so its flags, unchanged.
//! - `countKeptAtomRetirements(sourceIds)`: the retirements the rule keeps, by reason.
//!
//! The flags are the ones [`super::restorable_atoms`] evaluates, for every retirement (an origin-less one counts as
//! `origin_gone`), scoped to the listed sources: the live replacement check and the latest-retirement rank read only
//! atoms of those sources, the origin page check reads any live page of the atom's source.

use super::{
    ATOM_REEXTRACT_RETIRED_BY, atom_hash, atom_not_imported, atom_origin_key, fm_nonempty, fm_text,
};
use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::{PageRecord, all_pages, versions_of};
use crate::sources::read_source;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};

/// One retirement and the rule's flags.
struct Retirement<'a> {
    page: &'a PageRecord,
    hash: String,
    origin_live: bool,
    replaced: bool,
    latest: bool,
}

impl Retirement<'_> {
    fn restorable(&self) -> bool {
        self.origin_live && !self.replaced && self.latest
    }
}

/// `retired_at DESC NULLS LAST, id DESC`: true when `a` ranks before `b`.
fn ranks_before(a: (&Option<String>, u64), b: (&Option<String>, u64)) -> bool {
    let order = match (a.0, b.0) {
        (Some(x), Some(y)) => x.as_bytes().cmp(y.as_bytes()).then(a.1.cmp(&b.1)),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => a.1.cmp(&b.1),
    };
    order == Ordering::Greater
}

/// Every re-extraction retirement of the pages of `sources`, with its flags, by id.
fn retirements<'a>(pages: &'a [PageRecord], sources: &BTreeSet<&str>) -> Vec<Retirement<'a>> {
    let in_scope = |p: &PageRecord| sources.contains(p.source_id.as_str());
    let live_slugs: HashSet<(&str, &str)> = pages
        .iter()
        .filter(|p| p.deleted_at_us.is_none())
        .map(|p| (p.source_id.as_str(), p.slug.as_str()))
        .collect();
    let mut live_hashes: HashMap<(&str, String), HashSet<String>> = HashMap::new();
    for page in pages
        .iter()
        .filter(|p| p.deleted_at_us.is_none() && atom_not_imported(p) && in_scope(p))
    {
        if let Some(key) = atom_origin_key(page) {
            live_hashes
                .entry((page.source_id.as_str(), key))
                .or_default()
                .insert(atom_hash(page));
        }
    }
    let mut retired: Vec<(&PageRecord, Option<String>, String)> = pages
        .iter()
        .filter(|p| {
            p.deleted_at_us.is_some()
                && atom_not_imported(p)
                && in_scope(p)
                && fm_text(&p.frontmatter, "retired_by").as_deref()
                    == Some(ATOM_REEXTRACT_RETIRED_BY)
        })
        .map(|p| (p, atom_origin_key(p), atom_hash(p)))
        .collect();
    retired.sort_by_key(|(p, _, _)| p.id);
    let mut latest: HashMap<(&str, String), (Option<String>, u64, String)> = HashMap::new();
    for (page, key, hash) in &retired {
        let Some(key) = key else { continue };
        let rank = (
            fm_text(&page.frontmatter, "retired_at"),
            page.id,
            hash.clone(),
        );
        let slot = latest
            .entry((page.source_id.as_str(), key.clone()))
            .or_insert_with(|| rank.clone());
        if ranks_before((&rank.0, rank.1), (&slot.0, slot.1)) {
            *slot = rank;
        }
    }
    retired
        .into_iter()
        .map(|(page, key, hash)| {
            let group = key.as_ref().map(|k| (page.source_id.as_str(), k.clone()));
            let origin_live = key.is_some()
                && fm_nonempty(page, "source_slug").is_none_or(|slug| {
                    live_slugs.contains(&(page.source_id.as_str(), slug.as_str()))
                });
            let replaced = group
                .as_ref()
                .and_then(|g| live_hashes.get(g))
                .is_some_and(|hashes| hashes.iter().any(|h| *h != hash));
            let latest = group
                .as_ref()
                .and_then(|g| latest.get(g))
                .is_some_and(|l| l.2 == hash);
            Retirement {
                page,
                hash,
                origin_live,
                replaced,
                latest,
            }
        })
        .collect()
}

impl Store {
    /// `listRestorableAtoms(sourceIds, atomId)`: the restorable retirements of the sources (or atom `atomId` alone).
    pub fn list_restorable_atoms(
        &self,
        source_ids: &[String],
        atom_id: Option<i64>,
    ) -> Result<Vec<Value>> {
        for source in source_ids {
            no_nul("listRestorableAtoms", &[("sourceIds", source)])?;
        }
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let live_ids: HashMap<(&str, &str), u64> = pages
            .iter()
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| ((p.source_id.as_str(), p.slug.as_str()), p.id))
            .collect();
        let mut out = Vec::new();
        for r in retirements(&pages, &sources) {
            if !r.restorable()
                || atom_id.is_some_and(|id| i64::try_from(r.page.id).is_ok_and(|own| own != id))
            {
                continue;
            }
            let page = r.page;
            let origin_slug = fm_nonempty(page, "source_slug");
            let origin = origin_slug
                .clone()
                .or_else(|| fm_text(&page.frontmatter, "source_path"));
            let origin_page_id = origin_slug
                .as_deref()
                .and_then(|slug| live_ids.get(&(page.source_id.as_str(), slug)).copied());
            let version_id = versions_of(&*read, page.id)?
                .into_iter()
                .filter(|v| {
                    !v.is_deleted && fm_text(&v.frontmatter, "retired_by").is_none() && {
                        let raw = fm_text(&v.frontmatter, "source_hash").unwrap_or_default();
                        raw.strip_prefix("pending:").unwrap_or(&raw) == r.hash
                    }
                })
                .map(|v| v.id)
                .max();
            out.push(json!({
                "id": page.id,
                "source_id": page.source_id,
                "incarnation": read_source(&*read, &page.source_id)?.map(|s| s.incarnation),
                "slug": page.slug,
                "revision": page.knowledge_revision,
                "origin_kind": if origin_slug.is_some() { "page" } else { "transcript" },
                "origin": origin,
                "origin_page_id": origin_page_id,
                "hash": r.hash,
                "retired_at": fm_text(&page.frontmatter, "retired_at"),
                "version_id": version_id,
            }));
        }
        Ok(out)
    }

    /// `countKeptAtomRetirements(sourceIds)`: `{ origin_gone, replaced, older_generation }` over the retirements of the
    /// sources the rule keeps.
    pub fn count_kept_atom_retirements(&self, source_ids: &[String]) -> Result<Value> {
        for source in source_ids {
            no_nul("countKeptAtomRetirements", &[("sourceIds", source)])?;
        }
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let (mut gone, mut replaced, mut older) = (0u64, 0u64, 0u64);
        for r in retirements(&pages, &sources) {
            if !r.origin_live {
                gone += 1;
            } else if r.replaced {
                replaced += 1;
            } else if !r.latest {
                older += 1;
            }
        }
        Ok(json!({ "origin_gone": gone, "replaced": replaced, "older_generation": older }))
    }
}
