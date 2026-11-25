//! The reads and the one write `delete_page` and the label door make
//! (src/core/engine-sql/label-door.ts): `readPrivacyOrigin` and `listOriginDependents` (the derived-origin carry of
//! src/core/repair/origin-carry.ts), `listCheckoutFiles` (src/core/repair/label-write.ts `filesInCheckout`), and
//! `readPageLabelRow` and `writePageLabelGuard` (src/core/trust/page-write.ts `raisePageLabelGuard`). Each answers from
//! the page, link, alias, rename and source records the other families write; the label guard is a trust record
//! (`t 0x0e page_id`, see `crate::trust`).
//!
//! The privacy rules are `facts/privacy.rs` `privacy_allows`, the store's `privacyPartSql`. The dependents are
//! private-labels.ts `dependentsSql('remove')`: the SQL finds the pages that can name a cleared page through a jsonpath
//! probe and keeps only exact references, so a full read of the cleared sources' pages returns the same rows. Its
//! postimage (the pages table without the cleared rows, so the links to them go too) is [`Without`], a read that hides
//! the cleared pages' keys.
//!
//! See rust/docs/store/label_door.md.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Store;
use crate::aliases::{read_slug_alias, renamed_to};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::{chronicle_depth, declared_slugs, privacy_allows};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::{in_links, no_nul};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use crate::trust::label_guards::{self, LabelGuardRecord};

/// One origin of `listOriginDependents`: a page about to be removed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginRef {
    pub id: i64,
    pub source_id: String,
    pub slug: String,
}

/// `readPrivacyOrigin`: the page at (source, slug) when it is an origin.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrivacyOrigin {
    pub id: u64,
    pub deleted: bool,
}

/// One row of `listOriginDependents`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OriginDependent {
    pub id: u64,
    pub cleared_id: u64,
    pub source_id: String,
    pub slug: String,
    pub deleted: bool,
}

/// One row of `listCheckoutFiles`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CheckoutFile {
    pub id: u64,
    pub source_id: String,
    pub source_path: String,
    pub local_path: Option<String>,
}

/// One row of `readPageLabelRow`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PageLabelRow {
    pub id: u64,
    pub frontmatter: Map<String, Value>,
}

/// The postimage of a removal: `read` without the page records and id keys of `hidden`.
struct Without<'a> {
    read: &'a dyn KvRead,
    hidden: BTreeSet<Vec<u8>>,
}

impl KvRead for Without<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        if self.hidden.contains(key) {
            return Ok(None);
        }
        self.read.get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.read.scan(start, end, reverse, &mut |k, v| {
            self.hidden.contains(k) || f(k, v)
        })
    }
}

/// `originSql`: an atom, or a page the privacy rules hide.
pub(crate) fn is_origin(read: &dyn KvRead, page: &PageRecord, honor_aliases: bool) -> Result<bool> {
    Ok(page.page_type == "atom" || !privacy_allows(read, page, honor_aliases)?)
}

/// A reference of `dependentsSql('remove')`'s `refs`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    SourceSlug,
    Depth,
    Declared,
}

/// One reference of `dependentsSql('remove')`'s `refs`: the referring page's id, source and slug, the
/// reference kind and the slug it names. Only these fields are kept, so a source's page bodies are read
/// one page at a time and never held together.
struct PageRef {
    id: u64,
    source_id: String,
    slug: String,
    kind: Kind,
    target: String,
}

/// The references the pages of one source make (`refs`): `source_slug` and the slugs its rename alias and
/// rename history move it to, the chronicle depth parent, and each declared lineage slug. The scan keeps
/// only the reference fields of each page; the alias and rename lookups run after it.
fn source_refs(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRef>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(
        read,
        &keys::text(keys::PAGE, &[source_id, ""]),
        false,
        &mut |_, v| {
            match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => {
                    let mut push = |kind, target| {
                        out.push(PageRef {
                            id: page.id,
                            source_id: page.source_id.clone(),
                            slug: page.slug.clone(),
                            kind,
                            target,
                        })
                    };
                    if let Some(slug) = page
                        .frontmatter
                        .get("source_slug")
                        .and_then(jsonb_field_text)
                    {
                        push(Kind::SourceSlug, slug);
                    }
                    if let Some(depth) = chronicle_depth(&page) {
                        push(Kind::Depth, depth);
                    }
                    for slug in declared_slugs(&page.frontmatter).unwrap_or_default() {
                        push(Kind::Declared, slug);
                    }
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        },
    )?;
    if let Some(e) = failure {
        return Err(e);
    }
    let mut moved = Vec::new();
    for r in out.iter().filter(|r| r.kind == Kind::SourceSlug) {
        let also = |target| PageRef {
            id: r.id,
            source_id: r.source_id.clone(),
            slug: r.slug.clone(),
            kind: Kind::SourceSlug,
            target,
        };
        if let Some(alias) = read_slug_alias(read, &r.source_id, &r.target)?
            && alias.notes.as_deref() == Some("rename")
        {
            moved.push(also(alias.canonical_slug));
        }
        for to in renamed_to(read, &r.source_id, &r.target)? {
            moved.push(also(to));
        }
    }
    out.extend(moved);
    Ok(out)
}

fn page_ids(ids: &[i64]) -> Vec<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

impl Store {
    /// `readPrivacyOrigin(sourceId, slug)`: the page's id and whether it is soft-deleted, when it is an atom or the
    /// privacy rules hide it; `None` otherwise.
    pub fn read_privacy_origin(
        &self,
        source_id: &str,
        slug: &str,
        honor_aliases: bool,
    ) -> Result<Option<PrivacyOrigin>> {
        no_nul(
            "readPrivacyOrigin",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        Ok(
            is_origin(&*read, &page, honor_aliases)?.then(|| PrivacyOrigin {
                id: page.id,
                deleted: page.deleted_at_us.is_some(),
            }),
        )
    }

    /// `listOriginDependents(origins)`: each page the privacy rules hide now and would not once the origin rows are
    /// gone, with the origin it is tied to, by (id, origin id).
    pub fn list_origin_dependents(
        &self,
        origins: &[OriginRef],
        honor_aliases: bool,
    ) -> Result<Vec<OriginDependent>> {
        for origin in origins {
            no_nul(
                "listOriginDependents",
                &[("sourceId", &origin.source_id), ("slug", &origin.slug)],
            )?;
        }
        let read = self.read()?;
        let read = &*read;
        let cleared: Vec<(u64, &str, &str)> = origins
            .iter()
            .filter_map(|o| {
                u64::try_from(o.id)
                    .ok()
                    .map(|id| (id, o.source_id.as_str(), o.slug.as_str()))
            })
            .collect();
        let sources: BTreeSet<&str> = cleared.iter().map(|c| c.1).collect();
        let mut refs: Vec<PageRef> = Vec::new();
        for source in &sources {
            refs.extend(source_refs(read, source)?);
        }
        // hits: (reference, cleared id)
        let mut hits: Vec<(&PageRef, u64)> = Vec::new();
        for r in &refs {
            for (id, source, cleared_slug) in &cleared {
                if r.source_id == *source && r.target == *cleared_slug {
                    hits.push((r, *id));
                }
            }
        }
        let mut ties: BTreeSet<(u64, u64)> = BTreeSet::new();
        for (hit, cleared_id) in &hits {
            ties.insert((hit.id, *cleared_id));
            if hit.kind == Kind::Declared {
                for other in &refs {
                    if other.source_id == hit.source_id
                        && other.kind == Kind::Depth
                        && other.target == hit.slug
                    {
                        ties.insert((other.id, *cleared_id));
                    }
                }
            }
        }
        let mut provenance: Vec<(u64, u64, &str)> = cleared
            .iter()
            .map(|(id, source, _)| (*id, *id, *source))
            .collect();
        provenance.extend(
            hits.iter()
                .filter(|(hit, _)| hit.kind == Kind::SourceSlug)
                .map(|(hit, cleared_id)| (hit.id, *cleared_id, hit.source_id.as_str())),
        );
        for (to, cleared_id, source) in provenance {
            for link in in_links(read, to)? {
                if link.link_source.as_deref() == Some("concept-provenance")
                    && link.link_type == "synthesized_from"
                    && read_page_by_id(read, link.from_page_id)?
                        .is_some_and(|p| p.source_id == source)
                {
                    ties.insert((link.from_page_id, cleared_id));
                }
            }
        }
        let mut hidden = BTreeSet::new();
        for (id, _, _) in &cleared {
            if let Some(page) = read_page_by_id(read, *id)? {
                hidden.insert(keys::page(&page.source_id, &page.slug));
                hidden.insert(keys::page_id(page.id));
            }
        }
        let after = Without { read, hidden };
        let mut judged: BTreeMap<u64, Option<PageRecord>> = BTreeMap::new();
        let mut out = Vec::new();
        for (id, cleared_id) in ties {
            if id == cleared_id {
                continue;
            }
            if let std::collections::btree_map::Entry::Vacant(slot) = judged.entry(id) {
                let verdict = match read_page_by_id(read, id)? {
                    Some(page)
                        if privacy_allows(&after, &page, honor_aliases)?
                            && !privacy_allows(read, &page, honor_aliases)? =>
                    {
                        Some(page)
                    }
                    _ => None,
                };
                slot.insert(verdict);
            }
            if let Some(Some(page)) = judged.get(&id) {
                out.push(OriginDependent {
                    id,
                    cleared_id,
                    source_id: page.source_id.clone(),
                    slug: page.slug.clone(),
                    deleted: page.deleted_at_us.is_some(),
                });
            }
        }
        Ok(out)
    }

    /// `listCheckoutFiles(pageIds)`: each page among `page_ids` with a recorded file, its source's checkout, by id.
    pub fn list_checkout_files(&self, page_ids: &[i64]) -> Result<Vec<CheckoutFile>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in page_ids.iter().copied().collect::<BTreeSet<_>>() {
            let Ok(id) = u64::try_from(id) else { continue };
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            let Some(source_path) = page.source_path else {
                continue;
            };
            let Some(source) = read_source(&*read, &page.source_id)? else {
                continue;
            };
            out.push(CheckoutFile {
                id,
                source_id: page.source_id,
                source_path,
                local_path: source.local_path,
            });
        }
        Ok(out)
    }

    /// `readPageLabelRow(sourceId, slug)`: the page's id and stored frontmatter, soft-deleted or not.
    pub fn read_page_label_row(&self, source_id: &str, slug: &str) -> Result<Option<PageLabelRow>> {
        no_nul(
            "readPageLabelRow",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(
            read_page(&*read, source_id, slug)?.map(|page| PageLabelRow {
                id: page.id,
                frontmatter: page.frontmatter,
            }),
        )
    }

    /// `readLabelGuardTiers(pageId)`: the tiers the label guard of a write over the page raises to
    /// (trust/page-write.ts `labelGuardTier`): `owner_set`, the page's label guard tier, or none; `priors`, the prior
    /// tiers of its `lower_page` proposals since the owner last accepted one (`proposals::lower_page_prior_tiers`).
    pub fn read_label_guard_tiers(&self, page_id: i64) -> Result<Value> {
        let read = self.read()?;
        let owner_set = match u64::try_from(page_id) {
            Ok(id) => label_guards::read(&*read, id)?.map(|guard| guard.tier),
            Err(_) => None,
        };
        let priors = crate::trust::proposals::lower_page_prior_tiers(&*read, page_id)?;
        Ok(serde_json::json!({ "owner_set": owner_set, "priors": priors }))
    }

    /// The page's label guard (`SELECT tier, set_at FROM page_label_guards WHERE page_id = $1`), if any.
    pub fn read_page_label_guard(&self, page_id: i64) -> Result<Option<LabelGuardRecord>> {
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(None);
        };
        label_guards::read(&*self.read()?, id)
    }

    /// `writePageLabelGuard(pageId, tier)`: `None` deletes the page's label guard; a tier sets it, stamped now. A page
    /// that does not exist refuses `constraint_violation`, as the guard's foreign key does.
    pub fn write_page_label_guard(&self, page_id: i64, tier: Option<&str>) -> Result<()> {
        let tier = match tier {
            Some(name) => Some(crate::trust::TrustTier::parse(name).ok_or_else(|| {
                StoreError::invalid(format!("writePageLabelGuard: {name:?} is not a trust tier"))
            })?),
            None => None,
        };
        let env = self.env.clone();
        self.write(|tx| {
            let Some(id) = page_ids(&[page_id]).first().copied() else {
                return match tier {
                    None => Ok(()),
                    Some(_) => Err(missing_page(page_id)),
                };
            };
            match tier {
                None => label_guards::remove(tx, id),
                Some(tier) => {
                    if read_page_by_id(&*tx, id)?.is_none() {
                        return Err(missing_page(page_id));
                    }
                    let now = crate::env::transaction_clock::transaction_now()
                        .unwrap_or_else(|| env.now_micros());
                    label_guards::put(tx, id, tier, now)
                }
            }
        })
    }
}

fn missing_page(page_id: i64) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "writePageLabelGuard: page {page_id} does not exist (page_label_guards_page_id_fkey)"
        ),
    )
}
