//! The writes of the twin merge (`mergeTwinInto`, src/core/persistence/twin-merge.ts) that ran
//! through `executeRaw` (src/core/engine-sql/twin-merge.ts):
//!
//! - `listPageRelationshipKeys(pageIds)`: the distinct `(from, to, link_type)` keys of the links,
//!   then of the link transitions, that touch the pages (the relationship state the merge refreshes).
//! - `moveTwinRelations(twinId, survivorId)`: deletes the twin's link and transition rows that would
//!   land on another row's key (the losers `listTwinMergeLosers` lists), then points the rest of the
//!   twin's rows at the survivor. Rows that run between the pair stay.
//! - `moveTwinPageRows(args)`: timeline rows and event projections, raw data, the import-owned tag
//!   claim, files, page aliases, then the person-added tags; resolves the moved tags.
//! - `moveTwinFacts(sourceId, twinSlug, survivorSlug)`: facts other pages assert about the twin name
//!   the survivor; resolves their ids.
//! - `recordSlugRename(sourceId, oldSlug, newSlug)`: `recordRenameAlias`, the rename history and the
//!   `slug_aliases` row of the old slug.
//!
//! Each runs as one store write, so a refusal keeps nothing. Ids answer in id order, where the
//! `RETURNING` lists of SQL answer in storage order.

use crate::Store;
use crate::aliases::{move_twin_page_aliases, record_rename_alias};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::{entity_rows, write_fact};
use crate::link_queries::link_temporal::{
    TransitionRecord, all_transitions, delete_transition_rows, put_moved_transitions,
};
use crate::links::{
    LinkRecord, delete_link, in_links, no_nul, origin_page_links, out_links, put_link,
};
use crate::pages::{claim_twin_added_tags, move_twin_tags, read_page_by_id};
use crate::raw_files::{move_twin_files, move_twin_raw_data, page_has_raw_or_files};
use crate::repair_scans::twin_merge_losers;
use crate::timeline_queries::twin_rows::{move_twin_timeline, twin_has_timeline};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// One `RelationshipKey` of `src/core/link-relationships.ts`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct PageRelationshipKey {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
}

/// `moveTwinRelations`: how many loser rows went, the moved link ids and the moved transition count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TwinRelationsMoved {
    pub deduplicated: u64,
    pub links_moved: Vec<u64>,
    pub transitions_moved: u64,
}

/// `moveTwinPageRows(args)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TwinPageRowsArgs {
    pub source_id: String,
    pub twin_id: u64,
    pub survivor_id: u64,
    pub twin_slug: String,
    pub survivor_slug: String,
}

/// The pair's endpoints with the twin replaced by the survivor, or `None` for a row that stays: a
/// row not naming the twin, or one that runs between the pair.
fn mapped(
    from: u64,
    to: u64,
    origin: Option<u64>,
    twin: u64,
    survivor: u64,
) -> Option<(u64, u64, Option<u64>)> {
    let in_pair = |id: u64| id == twin || id == survivor;
    let moving = from == twin || to == twin || origin == Some(twin);
    if !moving || (in_pair(from) && in_pair(to)) {
        return None;
    }
    let map = |id: u64| if id == twin { survivor } else { id };
    Some((map(from), map(to), origin.map(map)))
}

fn twin_links(tx: &dyn crate::kv::KvRead, twin: u64) -> Result<BTreeMap<u64, LinkRecord>> {
    let mut links = BTreeMap::new();
    for link in out_links(tx, twin)?
        .into_iter()
        .chain(in_links(tx, twin)?)
        .chain(origin_page_links(tx, twin)?)
    {
        links.insert(link.id, link);
    }
    Ok(links)
}

/// The refusal of a move onto a page that does not exist, as the foreign keys on the moved rows refuse it (`23503`).
fn missing_survivor(table: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"{table}\" violates foreign key constraint: the survivor page does not exist"
        ),
    )
}

impl Store {
    /// `listPageRelationshipKeys(pageIds)`: the link keys, then the transition keys, each distinct
    /// and in key order.
    pub fn list_page_relationship_keys(
        &self,
        page_ids: &[u64],
    ) -> Result<Vec<PageRelationshipKey>> {
        let read = self.read()?;
        let pages: BTreeSet<u64> = page_ids.iter().copied().collect();
        let mut links = BTreeSet::new();
        for &page in &pages {
            for l in out_links(&*read, page)?
                .into_iter()
                .chain(in_links(&*read, page)?)
            {
                links.insert(PageRelationshipKey {
                    from_page_id: l.from_page_id,
                    to_page_id: l.to_page_id,
                    link_type: l.link_type,
                });
            }
        }
        let transitions: BTreeSet<PageRelationshipKey> = all_transitions(&*read)?
            .into_iter()
            .filter(|t| pages.contains(&t.from_page_id) || pages.contains(&t.to_page_id))
            .map(|t| PageRelationshipKey {
                from_page_id: t.from_page_id,
                to_page_id: t.to_page_id,
                link_type: t.link_type,
            })
            .collect();
        Ok(links.into_iter().chain(transitions).collect())
    }

    /// `moveTwinRelations(twinId, survivorId)` (see the module doc).
    pub fn move_twin_relations(&self, twin: u64, survivor: u64) -> Result<TwinRelationsMoved> {
        self.write(|tx| {
            let losers = twin_merge_losers(&*tx, survivor, twin)?;
            let doomed_links: BTreeSet<u64> = losers.links.iter().map(|l| l.id).collect();
            let doomed_transitions: BTreeSet<u64> =
                losers.transitions.iter().map(|t| t.id).collect();
            let mut links = twin_links(&*tx, twin)?;
            // A loser is always a moving row (the losers' `s.moving`), so it is one of the twin's.
            for id in &doomed_links {
                if let Some(link) = links.remove(id) {
                    delete_link(tx, &link)?;
                }
            }
            let transitions: Vec<TransitionRecord> = all_transitions(&*tx)?;
            let (gone, rest): (Vec<TransitionRecord>, Vec<TransitionRecord>) = transitions
                .into_iter()
                .partition(|t| doomed_transitions.contains(&t.id));
            delete_transition_rows(tx, &gone)?;

            let mut moved_links = Vec::new();
            for link in links.into_values() {
                let Some((from, to, origin)) = mapped(
                    link.from_page_id,
                    link.to_page_id,
                    link.origin_page_id,
                    twin,
                    survivor,
                ) else {
                    continue;
                };
                delete_link(tx, &link)?;
                moved_links.push(LinkRecord {
                    from_page_id: from,
                    to_page_id: to,
                    origin_page_id: origin,
                    ..link
                });
            }
            let survivor_missing = read_page_by_id(&*tx, survivor)?.is_none();
            if survivor_missing && !moved_links.is_empty() {
                return Err(missing_survivor("links"));
            }
            for link in &moved_links {
                if tx.get(&link.unique_key())?.is_some() {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "duplicate key value violates unique constraint on links",
                    ));
                }
                put_link(tx, link)?;
            }

            let mut moving: Vec<TransitionRecord> = Vec::new();
            let mut old_rows: Vec<TransitionRecord> = Vec::new();
            let mut rest = rest;
            rest.sort_by_key(|t| t.id);
            for t in rest {
                let Some((from, to, origin)) = mapped(
                    t.from_page_id,
                    t.to_page_id,
                    t.origin_page_id,
                    twin,
                    survivor,
                ) else {
                    continue;
                };
                moving.push(TransitionRecord {
                    from_page_id: from,
                    to_page_id: to,
                    origin_page_id: origin,
                    ..t.clone()
                });
                old_rows.push(t);
            }
            if survivor_missing && !moving.is_empty() {
                return Err(missing_survivor("link_transitions"));
            }
            delete_transition_rows(tx, &old_rows)?;
            put_moved_transitions(tx, &moving)?;

            Ok(TwinRelationsMoved {
                deduplicated: (doomed_links.len() + doomed_transitions.len()) as u64,
                links_moved: moved_links.iter().map(|l| l.id).collect(),
                transitions_moved: moving.len() as u64,
            })
        })
    }

    /// `moveTwinPageRows(args)` (see the module doc): resolves the tags that moved.
    pub fn move_twin_page_rows(&self, a: &TwinPageRowsArgs) -> Result<Vec<String>> {
        const OP: &str = "moveTwinPageRows";
        no_nul(
            OP,
            &[
                ("sourceId", a.source_id.as_str()),
                ("twinSlug", a.twin_slug.as_str()),
                ("survivorSlug", a.survivor_slug.as_str()),
            ],
        )?;
        self.write(|tx| {
            if read_page_by_id(&*tx, a.survivor_id)?.is_none() {
                if twin_has_timeline(&*tx, a.twin_id)? {
                    return Err(missing_survivor("timeline_entries"));
                }
                if page_has_raw_or_files(&*tx, a.twin_id)? {
                    return Err(missing_survivor("raw_data"));
                }
                if read_page_by_id(&*tx, a.twin_id)?.is_some_and(|t| {
                    t.tags.iter().any(|tag| {
                        t.tag_sources.get(tag).map(String::as_str) != Some("frontmatter")
                    })
                }) {
                    return Err(missing_survivor("tags"));
                }
            }
            move_twin_timeline(tx, a.twin_id, a.survivor_id)?;
            move_twin_raw_data(tx, a.twin_id, a.survivor_id)?;
            claim_twin_added_tags(tx, a.twin_id, a.survivor_id)?;
            move_twin_files(tx, a.twin_id, a.survivor_id, &a.survivor_slug)?;
            move_twin_page_aliases(tx, &a.source_id, &a.twin_slug, &a.survivor_slug)?;
            move_twin_tags(tx, &*self.env, a.twin_id, a.survivor_id)
        })
    }

    /// `moveTwinFacts(sourceId, twinSlug, survivorSlug)`: the facts of `source_id` about the twin
    /// that the twin's own page does not hold name the survivor; resolves their ids.
    pub fn move_twin_facts(&self, source_id: &str, twin: &str, survivor: &str) -> Result<Vec<u64>> {
        const OP: &str = "moveTwinFacts";
        no_nul(
            OP,
            &[
                ("sourceId", source_id),
                ("twinSlug", twin),
                ("survivorSlug", survivor),
            ],
        )?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut ids = Vec::new();
            for old in entity_rows(&*tx, source_id, twin)? {
                if old.source_markdown_slug.as_deref() == Some(twin) {
                    continue;
                }
                let mut new = old.clone();
                new.entity_slug = Some(survivor.to_string());
                write_fact(tx, trust, Some(&old), &new)?;
                ids.push(old.id);
            }
            ids.sort_unstable();
            Ok(ids)
        })
    }

    /// `recordSlugRename(sourceId, oldSlug, newSlug)`: `recordRenameAlias` in one write.
    pub fn record_slug_rename(&self, source_id: &str, old: &str, new: &str) -> Result<()> {
        const OP: &str = "recordSlugRename";
        no_nul(
            OP,
            &[("sourceId", source_id), ("oldSlug", old), ("newSlug", new)],
        )?;
        self.write(|tx| record_rename_alias(tx, source_id, old, new))
    }
}
