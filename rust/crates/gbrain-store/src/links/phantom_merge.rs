//! The phantom merge's link statements (src/core/engine-sql/facts-cycle.ts): `listOwnLinkIds`, `listLinkIdsOnPage`,
//! `repointInboundLinks` and `repointOutboundLinks`, which `cycle/phantom-redirect.ts` and
//! `cycle/phantom-redirect-managed.ts` ran through `executeRaw`.
//!
//! A repoint moves a link to its new endpoint under the same id: it deletes the four keys of the old record and puts
//! the four keys of the new one ([`delete_link`], [`put_link`]) in one transaction. A link whose new identity
//! (`from_page_id`, `to_page_id`, `link_type`, `link_source`, `origin_page_id`, nulls equal) another link already holds
//! stays where it is, as the statement's `NOT EXISTS` leaves it, and so does a link that would point a page at itself.
//! Moving a link onto a page id no page has refuses with `constraint_violation`, as the `links` foreign keys do.

use super::{LinkRecord, delete_link, in_links, link_at, out_links, put_link};
use crate::Store;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::pages::read_page_by_id;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listLinkIdsOnPage(ids, pageId)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkIdsOnPage {
    pub ids: Vec<f64>,
    pub page_id: f64,
}

/// `repointInboundLinks(phantomId, canonicalId)` / `repointOutboundLinks(phantomId, canonicalId)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RepointArgs {
    pub phantom_id: f64,
    pub canonical_id: f64,
}

/// A JavaScript number bound to an `integer` id parameter (every `links` and `pages` id column is `integer`). `None`
/// for an id no row can have (below 1).
fn id_arg(op: &str, what: &str, value: f64) -> Result<Option<u64>> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: invalid input syntax for type integer: \"{value}\" ({what})"),
        ));
    }
    if value.abs() > 2_147_483_647.0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: value \"{value}\" is out of range for type integer ({what})"),
        ));
    }
    Ok((value >= 1.0).then_some(value as u64))
}

/// The foreign-key refusal of a link moved onto a page id no page has.
fn missing_page(end: End) -> StoreError {
    let column = match end {
        End::To => "to_page_id",
        End::From => "from_page_id",
    };
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"links\" violates foreign key constraint \"links_{column}_fkey\""
        ),
    )
}

/// Which end of a link a repoint moves.
#[derive(Clone, Copy)]
enum End {
    To,
    From,
}

impl Store {
    /// `listOwnLinkIds(pageId)`: `{ id }` of the links page `pageId` starts and authored itself (`origin_page_id`
    /// null), by id.
    pub fn list_own_link_ids(&self, page_id: f64) -> Result<Vec<Value>> {
        let Some(page) = id_arg("listOwnLinkIds", "pageId", page_id)? else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(out_links(&*read, page)?
            .iter()
            .filter(|l| l.origin_page_id.is_none())
            .map(|l| json!({ "id": l.id }))
            .collect())
    }

    /// `listLinkIdsOnPage(ids, pageId)`: `{ id }` of the named links that start at page `pageId`, by id.
    pub fn list_link_ids_on_page(&self, q: &LinkIdsOnPage) -> Result<Vec<Value>> {
        const OP: &str = "listLinkIdsOnPage";
        let mut ids = BTreeSet::new();
        for &id in &q.ids {
            if let Some(id) = id_arg(OP, "ids", id)? {
                ids.insert(id);
            }
        }
        let Some(page) = id_arg(OP, "pageId", q.page_id)? else {
            return Ok(Vec::new());
        };
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        Ok(out_links(&*read, page)?
            .iter()
            .filter(|l| ids.contains(&l.id))
            .map(|l| json!({ "id": l.id }))
            .collect())
    }

    /// `repointInboundLinks(phantomId, canonicalId)`: moves `to_page_id` of the links that reach the phantom onto the
    /// canonical page.
    pub fn repoint_inbound_links(&self, a: &RepointArgs) -> Result<()> {
        self.repoint_links("repointInboundLinks", a, End::To)
    }

    /// `repointOutboundLinks(phantomId, canonicalId)`: moves `from_page_id` of the links that leave the phantom onto
    /// the canonical page.
    pub fn repoint_outbound_links(&self, a: &RepointArgs) -> Result<()> {
        self.repoint_links("repointOutboundLinks", a, End::From)
    }

    fn repoint_links(&self, op: &str, a: &RepointArgs, end: End) -> Result<()> {
        let phantom = id_arg(op, "phantomId", a.phantom_id)?;
        let canonical = id_arg(op, "canonicalId", a.canonical_id)?;
        let Some(phantom) = phantom else {
            return Ok(());
        };
        self.write(|tx| {
            let links = match end {
                End::To => in_links(&*tx, phantom)?,
                End::From => out_links(&*tx, phantom)?,
            };
            // The statement reads its `NOT EXISTS` against the rows as they were before it ran.
            let mut planned: Vec<(LinkRecord, LinkRecord)> = Vec::new();
            let Some(canonical) = canonical else {
                // No page has an id below 1: moving any link there breaks the foreign key.
                return if links.is_empty() {
                    Ok(())
                } else {
                    Err(missing_page(end))
                };
            };
            for old in links {
                let mut new = old.clone();
                match end {
                    End::To => {
                        if old.from_page_id == canonical {
                            continue;
                        }
                        new.to_page_id = canonical;
                    }
                    End::From => {
                        if old.to_page_id == canonical {
                            continue;
                        }
                        new.from_page_id = canonical;
                    }
                }
                if link_at(&*tx, new.from_page_id, &new.unique_key())?.is_some() {
                    continue;
                }
                planned.push((old, new));
            }
            if planned.is_empty() {
                return Ok(());
            }
            if read_page_by_id(&*tx, canonical)?.is_none() {
                return Err(missing_page(end));
            }
            for (old, new) in &planned {
                delete_link(tx, old)?;
                put_link(tx, new)?;
            }
            Ok(())
        })
    }
}
