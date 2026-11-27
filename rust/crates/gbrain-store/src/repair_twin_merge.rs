//! The moves of the twin merge (`persistence/twin-merge.ts` `mergeTwinInto`, SQL in
//! `src/core/engine-sql/twin-merge-moves.ts`): `moveTwinRelationships`, `moveTwinPageChildren` and `moveTwinFacts`.
//!
//! Each member is one write transaction (inside the engine's own transaction when the store is bound to one) that
//! answers what the SQL statements answer:
//!
//! - `moveTwinRelationships`: the relationship keys of the twin (links and link transitions, as the key read sees
//!   them), the colliding rows dropped (`listTwinMergeLosers`' link and transition losers), the rest of the twin's rows
//!   re-pointed at the survivor in every role (`from`, `to`, `origin`) except the rows between the pair, and the keys of
//!   the survivor. Links move through `delete_link` and `put_link` (the four keys), transitions through the link
//!   temporal helpers (their key holds the relationship).
//! - `moveTwinPageChildren`: the twin's timeline rows and events (`timeline_queries/twin_move.rs`), raw data of a
//!   source the survivor lacks, a survivor tag the import owns claimed `added` when the twin's was, the user-added
//!   (or unclaimed) tags the survivor lacks, file attachments and the page aliases the survivor does not repeat.
//!   A tag move advances both pages' revisions, as the tag trigger does. The moved tags come back in the twin's tag
//!   order (Postgres' order is unspecified).
//! - `moveTwinFacts`: the facts of a source that other pages assert about the twin slug (`source_markdown_slug` is
//!   not the twin) take the survivor slug, each through `write_fact` (its indexes, its stamps, its unique keys); the
//!   moved ids by id.
//!
//! A non-integer or negative page id names no page. The twin and its survivor being one page refuses with
//! `invalid_argument`. A move that would attach rows to a survivor page that does not exist refuses as the foreign
//! key does.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::{entity_rows, write_fact};
use crate::kv::{KvRead, KvWrite};
use crate::link_queries::link_temporal::{
    RelationshipKey, TransitionRecord, all_transitions, delete_transition, put_moved_transition,
};
use crate::links::{
    LinkRecord, delete_link, in_links, no_nul, origin_page_links, out_links, put_link,
    unique_violation,
};
use crate::pages::{TAG_ADDED, TAG_FRONTMATTER, read_page_by_id, tag_change, write_page};
use crate::raw_files::{first_page_child_table, move_files, move_raw_data};
use crate::repair_scans::{twin_link_losers, twin_transition_losers};
use crate::timeline_queries::{move_twin_timeline, twin_timeline_reference};

/// `TwinMergeIds`: the twin and the page that replaces it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TwinMergeIds {
    pub twin_id: i64,
    pub survivor_id: i64,
}

/// `TwinPageChildrenMove`: which page, by id, slug and source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TwinPageChildrenMove {
    pub twin_id: i64,
    pub survivor_id: i64,
    pub source_id: String,
    pub twin_slug: String,
    pub survivor_slug: String,
}

/// `TwinRelationshipMoves`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinRelationshipMoves {
    pub before: Vec<RelationshipKey>,
    pub after: Vec<RelationshipKey>,
    pub links_moved: Vec<u64>,
    pub transitions_moved: u64,
    pub deduplicated: u64,
}

fn same_page() -> StoreError {
    StoreError::invalid("the twin and its survivor are one page")
}

fn missing_survivor(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"{table}\" violates foreign key constraint \"{table}_{column}_fkey\": the survivor page is not present"
        ),
    )
}

/// `RELATIONSHIP_KEYS_SQL` for one page: the distinct keys of its links, then of its link transitions, each list in key
/// order (the SQL's order is unspecified).
fn relationship_keys(read: &dyn KvRead, page: u64) -> Result<Vec<RelationshipKey>> {
    let mut links: BTreeSet<RelationshipKey> = BTreeSet::new();
    for link in out_links(read, page)?
        .iter()
        .chain(in_links(read, page)?.iter())
    {
        links.insert(RelationshipKey::of_link(link));
    }
    let mut transitions: BTreeSet<RelationshipKey> = BTreeSet::new();
    for t in all_transitions(read)? {
        if t.from_page_id == page || t.to_page_id == page {
            transitions.insert(RelationshipKey::new(
                t.from_page_id,
                t.to_page_id,
                &t.link_type,
            ));
        }
    }
    Ok(links.into_iter().chain(transitions).collect())
}

impl Store {
    /// `moveTwinRelationships({ twinId, survivorId })`.
    pub fn move_twin_relationships(&self, ids: &TwinMergeIds) -> Result<TwinRelationshipMoves> {
        let (Ok(twin), Ok(survivor)) = (u64::try_from(ids.twin_id), u64::try_from(ids.survivor_id))
        else {
            return Ok(TwinRelationshipMoves {
                before: Vec::new(),
                after: Vec::new(),
                links_moved: Vec::new(),
                transitions_moved: 0,
                deduplicated: 0,
            });
        };
        if twin == survivor {
            return Err(same_page());
        }
        self.write(|tx| {
            let before = relationship_keys(&*tx, twin)?;
            let link_losers: BTreeSet<u64> = twin_link_losers(&*tx, survivor, twin)?
                .into_iter()
                .map(|l| l.id)
                .collect();
            let transition_losers: BTreeSet<u64> = twin_transition_losers(&*tx, survivor, twin)?
                .into_iter()
                .map(|t| t.id)
                .collect();
            let in_pair = |id: u64| id == twin || id == survivor;
            let map = |id: u64| if id == twin { survivor } else { id };

            let mut touching: BTreeMap<u64, LinkRecord> = BTreeMap::new();
            for link in out_links(&*tx, twin)?
                .into_iter()
                .chain(in_links(&*tx, twin)?)
                .chain(origin_page_links(&*tx, twin)?)
            {
                touching.insert(link.id, link);
            }
            let mut moving_links = Vec::new();
            for (id, link) in touching {
                if link_losers.contains(&id) {
                    delete_link(tx, &link)?;
                } else if !(in_pair(link.from_page_id) && in_pair(link.to_page_id)) {
                    delete_link(tx, &link)?;
                    moving_links.push(LinkRecord {
                        from_page_id: map(link.from_page_id),
                        to_page_id: map(link.to_page_id),
                        origin_page_id: link.origin_page_id.map(map),
                        ..link
                    });
                }
            }
            let mut moving_transitions: Vec<TransitionRecord> = Vec::new();
            let mut touching_transitions = all_transitions(&*tx)?;
            touching_transitions.sort_by_key(|t| t.id);
            for t in touching_transitions {
                let touches = t.from_page_id == twin
                    || t.to_page_id == twin
                    || t.origin_page_id == Some(twin);
                if !touches {
                    continue;
                }
                if transition_losers.contains(&t.id) {
                    delete_transition(tx, &t)?;
                } else if !(in_pair(t.from_page_id) && in_pair(t.to_page_id)) {
                    delete_transition(tx, &t)?;
                    moving_transitions.push(TransitionRecord {
                        from_page_id: map(t.from_page_id),
                        to_page_id: map(t.to_page_id),
                        origin_page_id: t.origin_page_id.map(map),
                        ..t
                    });
                }
            }
            if (!moving_links.is_empty() || !moving_transitions.is_empty())
                && read_page_by_id(&*tx, survivor)?.is_none()
            {
                return Err(missing_survivor("links", "to_page_id"));
            }
            let mut links_moved = Vec::with_capacity(moving_links.len());
            for link in &moving_links {
                if tx.get(&link.unique_key())?.is_some() {
                    return Err(unique_violation());
                }
                put_link(tx, link)?;
                links_moved.push(link.id);
            }
            for t in &moving_transitions {
                put_moved_transition(tx, t)?;
            }
            links_moved.sort_unstable();
            let after = relationship_keys(&*tx, survivor)?;
            Ok(TwinRelationshipMoves {
                before,
                after,
                links_moved,
                transitions_moved: moving_transitions.len() as u64,
                deduplicated: (link_losers.len() + transition_losers.len()) as u64,
            })
        })
    }

    /// `moveTwinPageChildren(move)`: the tags moved to the survivor.
    pub fn move_twin_page_children(&self, mv: &TwinPageChildrenMove) -> Result<Vec<String>> {
        no_nul(
            "moveTwinPageChildren",
            &[
                ("sourceId", &mv.source_id),
                ("twinSlug", &mv.twin_slug),
                ("survivorSlug", &mv.survivor_slug),
            ],
        )?;
        let (Ok(twin), Ok(survivor)) = (u64::try_from(mv.twin_id), u64::try_from(mv.survivor_id))
        else {
            return Ok(Vec::new());
        };
        if twin == survivor {
            return Err(same_page());
        }
        self.write(|tx| {
            // The foreign keys refuse a move onto a page that does not exist at the first statement that moves a row:
            // the timeline, then raw data and files (the tags move refuses on its own).
            if read_page_by_id(&*tx, survivor)?.is_none() {
                if let Some(column) = twin_timeline_reference(&*tx, twin)? {
                    return Err(missing_survivor("timeline_entries", column));
                }
                if let Some(table) = first_page_child_table(&*tx, twin)? {
                    return Err(missing_survivor(table, "page_id"));
                }
            }
            move_twin_timeline(tx, twin, survivor)?;
            move_raw_data(tx, twin, survivor)?;
            claim_survivor_tags(tx, twin, survivor)?;
            move_files(tx, twin, survivor, &mv.survivor_slug)?;
            crate::aliases::move_twin_page_aliases(
                tx,
                &mv.source_id,
                &mv.twin_slug,
                &mv.survivor_slug,
            )?;
            move_tags(tx, &*self.env, twin, survivor)
        })
    }

    /// `moveTwinFacts(sourceId, twinSlug, survivorSlug)`: the moved fact ids, by id.
    pub fn move_twin_facts(
        &self,
        source_id: &str,
        twin_slug: &str,
        survivor_slug: &str,
    ) -> Result<Vec<u64>> {
        no_nul(
            "moveTwinFacts",
            &[
                ("sourceId", source_id),
                ("twinSlug", twin_slug),
                ("survivorSlug", survivor_slug),
            ],
        )?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut moved = Vec::new();
            for row in entity_rows(&*tx, source_id, twin_slug)? {
                if row.source_markdown_slug.as_deref() == Some(twin_slug) {
                    continue;
                }
                let mut new = row.clone();
                new.entity_slug = Some(survivor_slug.to_string());
                write_fact(tx, trust, Some(&row), &new)?;
                moved.push(row.id);
            }
            moved.sort_unstable();
            Ok(moved)
        })
    }
}

/// `UPDATE tags o SET tag_source = 'added' WHERE o.page_id = survivor AND o.tag_source = 'frontmatter' AND EXISTS (the
/// twin's `added` row of the tag)`. A claim alone moves no revision (the tag trigger skips a row whose page and tag
/// stay).
fn claim_survivor_tags(tx: &mut dyn KvWrite, twin: u64, survivor: u64) -> Result<()> {
    let (Some(twin), Some(mut survivor)) = (
        read_page_by_id(&*tx, twin)?,
        read_page_by_id(&*tx, survivor)?,
    ) else {
        return Ok(());
    };
    let mut claimed = false;
    for tag in survivor.tags.clone() {
        if survivor.tag_sources.get(&tag).map(String::as_str) == Some(TAG_FRONTMATTER)
            && twin.tags.contains(&tag)
            && twin.tag_sources.get(&tag).map(String::as_str) == Some(TAG_ADDED)
        {
            survivor.tag_sources.insert(tag, TAG_ADDED.to_string());
            claimed = true;
        }
    }
    if claimed {
        write_page(tx, &survivor)?;
    }
    Ok(())
}

/// `UPDATE tags s SET page_id = survivor WHERE s.page_id = twin AND s.tag_source IS DISTINCT FROM 'frontmatter' AND
/// NOT EXISTS (the survivor's row of the tag) RETURNING tag`: the moved tags in the twin's order. Each moved row
/// advances the revision of both pages, once for the move.
fn move_tags(
    tx: &mut dyn KvWrite,
    env: &dyn crate::env::Env,
    twin: u64,
    survivor: u64,
) -> Result<Vec<String>> {
    let Some(mut from) = read_page_by_id(&*tx, twin)? else {
        return Ok(Vec::new());
    };
    let to = read_page_by_id(&*tx, survivor)?;
    let moved: Vec<String> = from
        .tags
        .iter()
        .filter(|t| {
            from.tag_sources.get(*t).map(String::as_str) != Some(TAG_FRONTMATTER)
                && to.as_ref().is_none_or(|p| !p.tags.contains(t))
        })
        .cloned()
        .collect();
    if moved.is_empty() {
        return Ok(moved);
    }
    let Some(mut to) = to else {
        return Err(missing_survivor("tags", "page_id"));
    };
    for tag in &moved {
        from.tags.retain(|t| t != tag);
        to.tags.push(tag.clone());
        if let Some(source) = from.tag_sources.remove(tag) {
            to.tag_sources.insert(tag.clone(), source);
        }
    }
    tag_change(tx, env, &mut from)?;
    tag_change(tx, env, &mut to)?;
    Ok(moved)
}
