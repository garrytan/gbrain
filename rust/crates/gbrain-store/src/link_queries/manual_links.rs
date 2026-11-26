//! Managed link edits (`manualLinkStore()`, `src/core/engine-sql/manual-links.ts`;
//! rust/docs/store/managed-mode.md): what `add_link` and `remove_link` on a
//! managed page read and delete, and the links fence projection that rewrites the page's fenced
//! edges and their manual dated statements.
//!
//! Each kind answers what its Postgres statement answers, from the link records (`links.rs`),
//! the page records and the link-transition records (`link_temporal.rs`). The relationship filter
//! is the SQL's: the from page `page_id`, a target page of source `source_id` named `to`
//! (deleted or not, as the join does), the link type when given and the link source when given.
//! A database-only edge is not projected from a links fence and has a provenance no
//! reconciliation producer owns (`link_source <> ALL(managed)`: a null source never matches
//! unless the list is empty); a fenced edge is projected by this page's fence.

use super::link_temporal::{
    TransitionRecord, all_transitions, delete_transition, insert_transition,
};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::links::{
    LinkRecord, NEXT_LINK_ID, check_link, delete_link, origin_page_links, out_links, put_link,
};
use crate::pages::{next_id, read_page, read_page_by_id};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `LINKS_FENCE_ORIGIN_FIELD`.
const FENCE: &str = "links_fence";

/// The relationship one link edit names.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualRelationship {
    pub page_id: u64,
    pub source_id: String,
    pub to: String,
    #[serde(default)]
    pub managed_sources: Vec<String>,
    #[serde(default)]
    pub link_type: Option<String>,
    #[serde(default)]
    pub link_source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemovedRow {
    pub to_page_id: u64,
    pub link_type: String,
    #[serde(default)]
    pub link_source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextRow {
    pub id: u64,
    pub context: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FenceLinkRow {
    pub to_page_id: u64,
    pub link_type: String,
    pub context: String,
    #[serde(default)]
    pub link_source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransitionRow {
    pub to_page_id: u64,
    pub link_type: String,
    #[serde(default)]
    pub link_source: Option<String>,
    pub kind: String,
    pub occurred_on: String,
}

/// One read of `manualLinkStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ManualLinkRead {
    FencedEdges {
        page_id: u64,
        origin_field: String,
    },
    ManualStatements {
        page_id: u64,
    },
    FencedTargets {
        page_id: u64,
        origin_field: String,
    },
    CountRelationship {
        rel: ManualRelationship,
    },
    DerivedEdges {
        rel: ManualRelationship,
    },
    PageIds {
        source_id: String,
        slugs: Vec<String>,
    },
    FenceEdges {
        page_id: u64,
        origin_field: String,
    },
    FenceTransitions {
        page_id: u64,
    },
}

/// One write of `manualLinkStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ManualLinkWrite {
    DeleteDatabaseOnly {
        rel: ManualRelationship,
    },
    DropRelationship {
        rel: ManualRelationship,
        with_fenced: bool,
    },
    DeleteRowTransitions {
        page_id: u64,
        origin_field: String,
        rows: Vec<RemovedRow>,
    },
    DeleteLinks {
        page_id: u64,
        ids: Vec<u64>,
    },
    UpdateContexts {
        page_id: u64,
        rows: Vec<ContextRow>,
    },
    InsertFenceLinks {
        page_id: u64,
        origin_field: String,
        rows: Vec<FenceLinkRow>,
    },
    DeleteTransitions {
        ids: Vec<u64>,
    },
    InsertTransitions {
        source_id: String,
        page_id: u64,
        rows: Vec<TransitionRow>,
    },
}

fn target_slug(read: &dyn KvRead, link: &LinkRecord) -> Result<Option<(String, String, bool)>> {
    Ok(read_page_by_id(read, link.to_page_id)?
        .map(|p| (p.source_id, p.slug, p.deleted_at_us.is_some())))
}

fn on_relationship(read: &dyn KvRead, rel: &ManualRelationship, link: &LinkRecord) -> Result<bool> {
    if link.from_page_id != rel.page_id
        || rel
            .link_type
            .as_deref()
            .is_some_and(|t| t != link.link_type)
        || rel
            .link_source
            .as_deref()
            .is_some_and(|s| link.link_source.as_deref() != Some(s))
    {
        return Ok(false);
    }
    Ok(target_slug(read, link)?
        .is_some_and(|(source, slug, _)| source == rel.source_id && slug == rel.to))
}

fn database_only(rel: &ManualRelationship, link: &LinkRecord) -> bool {
    link.origin_field.as_deref() != Some(FENCE)
        && (rel.managed_sources.is_empty()
            || link
                .link_source
                .as_deref()
                .is_some_and(|s| !rel.managed_sources.iter().any(|m| m == s)))
}

fn fenced(page_id: u64, link: &LinkRecord) -> bool {
    link.origin_field.as_deref() == Some(FENCE) && link.origin_page_id == Some(page_id)
}

fn fence_links(read: &dyn KvRead, page_id: u64, field: &str) -> Result<Vec<LinkRecord>> {
    Ok(origin_page_links(read, page_id)?
        .into_iter()
        .filter(|l| l.from_page_id == page_id && l.origin_field.as_deref() == Some(field))
        .collect())
}

fn manual_transitions(read: &dyn KvRead, page_id: u64) -> Result<Vec<TransitionRecord>> {
    Ok(all_transitions(read)?
        .into_iter()
        .filter(|t| {
            t.origin_page_id == Some(page_id) && t.from_page_id == page_id && t.producer == "manual"
        })
        .collect())
}

fn relationship_links(read: &dyn KvRead, rel: &ManualRelationship) -> Result<Vec<LinkRecord>> {
    let mut out = Vec::new();
    for link in out_links(read, rel.page_id)? {
        if on_relationship(read, rel, &link)? {
            out.push(link);
        }
    }
    Ok(out)
}

fn manual_link_rows_in(read: &dyn KvRead, what: &ManualLinkRead) -> Result<Value> {
    match what {
        ManualLinkRead::FencedEdges { page_id, origin_field } => {
            let mut rows = Vec::new();
            for l in fence_links(read, *page_id, origin_field)? {
                // `JOIN pages t`: an edge whose target is gone has no row.
                if let Some((_, slug, _)) = target_slug(read, &l)? {
                    rows.push((slug, l));
                }
            }
            rows.sort_by(|(a, x), (b, y)| {
                (a.as_bytes(), x.link_type.as_bytes(), x.link_source.as_deref().map(str::as_bytes))
                    .cmp(&(b.as_bytes(), y.link_type.as_bytes(), y.link_source.as_deref().map(str::as_bytes)))
            });
            Ok(Value::Array(rows.into_iter().map(|(slug, l)| json!({ "to_page_id": l.to_page_id, "to": slug,
                "type": l.link_type, "source": l.link_source, "context": l.context })).collect()))
        }
        ManualLinkRead::ManualStatements { page_id } => Ok(Value::Array(manual_transitions(read, *page_id)?
            .iter()
            .map(|t| json!({ "to_page_id": t.to_page_id, "type": t.link_type, "source": t.link_source, "kind": t.kind, "on": t.occurred_on }))
            .collect())),
        ManualLinkRead::FencedTargets { page_id, origin_field } => {
            let mut seen = BTreeSet::new();
            for l in fence_links(read, *page_id, origin_field)? {
                if let Some((_, slug, deleted)) = target_slug(read, &l)? {
                    seen.insert((slug, deleted));
                }
            }
            Ok(Value::Array(seen.into_iter().map(|(slug, deleted)| json!({ "slug": slug, "deleted": deleted })).collect()))
        }
        ManualLinkRead::CountRelationship { rel } => Ok(json!(relationship_links(read, rel)?
            .iter()
            .filter(|l| database_only(rel, l) || fenced(rel.page_id, l))
            .count())),
        ManualLinkRead::DerivedEdges { rel } => {
            let mut seen = BTreeSet::new();
            for l in relationship_links(read, rel)? {
                if let Some(s) = l.link_source.as_deref()
                    && rel.managed_sources.iter().any(|m| m == s)
                {
                    seen.insert((l.link_type.clone(), s.to_string()));
                }
            }
            Ok(Value::Array(seen.into_iter().map(|(t, s)| json!({ "link_type": t, "link_source": s })).collect()))
        }
        ManualLinkRead::PageIds { source_id, slugs } => {
            let mut rows = Vec::new();
            for slug in slugs.iter().collect::<BTreeSet<_>>() {
                if let Some(p) = read_page(read, source_id, slug)?
                    && p.deleted_at_us.is_none()
                {
                    rows.push(json!({ "id": p.id, "slug": p.slug }));
                }
            }
            Ok(Value::Array(rows))
        }
        ManualLinkRead::FenceEdges { page_id, origin_field } => Ok(Value::Array(fence_links(read, *page_id, origin_field)?
            .iter()
            .map(|l| json!({ "id": l.id, "to_page_id": l.to_page_id, "link_type": l.link_type, "link_source": l.link_source, "context": l.context }))
            .collect())),
        ManualLinkRead::FenceTransitions { page_id } => Ok(Value::Array(manual_transitions(read, *page_id)?
            .iter()
            .map(|t| json!({ "id": t.id, "to_page_id": t.to_page_id, "link_type": t.link_type, "link_source": t.link_source,
                "kind": t.kind, "occurred_on": t.occurred_on }))
            .collect())),
    }
}

fn manual_link_write_in(tx: &mut dyn KvWrite, now: i64, what: &ManualLinkWrite) -> Result<Value> {
    match what {
        ManualLinkWrite::DeleteDatabaseOnly { rel } => {
            for l in relationship_links(&*tx, rel)? {
                if database_only(rel, &l) && l.origin_page_id.is_none() {
                    delete_link(tx, &l)?;
                }
            }
            Ok(Value::Null)
        }
        ManualLinkWrite::DropRelationship { rel, with_fenced } => {
            let mut dropped = Vec::new();
            for l in relationship_links(&*tx, rel)? {
                if database_only(rel, &l) || (*with_fenced && fenced(rel.page_id, &l)) {
                    delete_link(tx, &l)?;
                    dropped.push(json!({ "to_page_id": l.to_page_id, "link_type": l.link_type, "link_source": l.link_source,
                        "fenced": l.origin_field.as_deref() == Some(FENCE) }));
                }
            }
            Ok(Value::Array(dropped))
        }
        ManualLinkWrite::DeleteRowTransitions {
            page_id,
            origin_field,
            rows,
        } => {
            // The NOT EXISTS reads the links as they stand when the statement runs.
            let kept = fence_links(&*tx, *page_id, origin_field)?;
            let mut keys = Vec::new();
            for t in manual_transitions(&*tx, *page_id)? {
                let hit = rows.iter().any(|r| {
                    r.to_page_id == t.to_page_id
                        && r.link_type == t.link_type
                        && (r.link_source.is_some() && t.link_source == r.link_source
                            || t.link_source.is_none()
                                && !kept.iter().any(|l| {
                                    l.to_page_id == r.to_page_id && l.link_type == r.link_type
                                }))
                });
                if hit {
                    delete_transition(tx, &t)?;
                    keys.push(json!({ "from_page_id": t.from_page_id, "to_page_id": t.to_page_id, "link_type": t.link_type }));
                }
            }
            Ok(Value::Array(keys))
        }
        ManualLinkWrite::DeleteLinks { page_id, ids } => {
            for l in out_links(&*tx, *page_id)? {
                if ids.contains(&l.id) {
                    delete_link(tx, &l)?;
                }
            }
            Ok(Value::Null)
        }
        ManualLinkWrite::UpdateContexts { page_id, rows } => {
            for mut l in out_links(&*tx, *page_id)? {
                if let Some(r) = rows.iter().find(|r| r.id == l.id) {
                    l.context = r.context.clone();
                    put_link(tx, &l)?;
                }
            }
            Ok(Value::Null)
        }
        ManualLinkWrite::InsertFenceLinks {
            page_id,
            origin_field,
            rows,
        } => {
            for r in rows {
                let existing = out_links(&*tx, *page_id)?.into_iter().find(|l| {
                    l.to_page_id == r.to_page_id
                        && l.link_type == r.link_type
                        && l.link_source == r.link_source
                        && l.origin_page_id == Some(*page_id)
                });
                match existing {
                    // `ON CONFLICT (...) DO UPDATE SET context=EXCLUDED.context, origin_field=EXCLUDED.origin_field`.
                    Some(mut l) => {
                        delete_link(tx, &l)?;
                        l.context = r.context.clone();
                        l.origin_field = Some(origin_field.clone());
                        put_link(tx, &l)?;
                    }
                    None => {
                        if read_page_by_id(&*tx, r.to_page_id)?.is_none() {
                            return Err(StoreError::new(
                                crate::error::CONSTRAINT_VIOLATION,
                                "insert or update on table \"links\" violates foreign key constraint \"links_to_page_id_fkey\"",
                            ));
                        }
                        let record = LinkRecord {
                            id: next_id(tx, NEXT_LINK_ID)?,
                            from_page_id: *page_id,
                            to_page_id: r.to_page_id,
                            link_type: r.link_type.clone(),
                            context: r.context.clone(),
                            link_source: r.link_source.clone(),
                            link_kind: None,
                            origin_page_id: Some(*page_id),
                            origin_field: Some(origin_field.clone()),
                            resolution_type: None,
                            created_at_us: now,
                            assertion_tense: None,
                        };
                        check_link(&record)?;
                        put_link(tx, &record)?;
                    }
                }
            }
            Ok(Value::Null)
        }
        ManualLinkWrite::DeleteTransitions { ids } => {
            for t in all_transitions(&*tx)? {
                if ids.contains(&t.id) {
                    delete_transition(tx, &t)?;
                }
            }
            Ok(Value::Null)
        }
        ManualLinkWrite::InsertTransitions {
            source_id,
            page_id,
            rows,
        } => {
            for r in rows {
                insert_transition(
                    tx,
                    TransitionRecord {
                        id: 0,
                        source_id: source_id.clone(),
                        from_page_id: *page_id,
                        to_page_id: r.to_page_id,
                        link_type: r.link_type.clone(),
                        kind: r.kind.clone(),
                        occurred_on: r.occurred_on.clone(),
                        date_precision: "day".into(),
                        producer: "manual".into(),
                        origin_page_id: Some(*page_id),
                        line_hash: String::new(),
                        link_source: r.link_source.clone(),
                        created_at_us: now,
                    },
                )?;
            }
            Ok(Value::Null)
        }
    }
}

impl crate::Store {
    /// One `manualLinkStore()` read (`ManualLinkRead`) as JSON.
    pub fn manual_link_rows(&self, what: &ManualLinkRead) -> Result<Value> {
        manual_link_rows_in(&*self.read()?, what)
    }

    /// One `manualLinkStore()` write (`ManualLinkWrite`); its result as JSON.
    pub fn manual_link_write(&self, what: &ManualLinkWrite) -> Result<Value> {
        let now = self.env.now_micros();
        self.write(|tx| manual_link_write_in(tx, now, what))
    }
}
