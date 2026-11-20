//! The belief ledger's page lifetimes and the orphan read over them (`orphanLifetimes`,
//! `src/core/engine-sql/collate-belief-reads.ts`). PGLite and Postgres run the SQL over
//! `belief_page_lifetimes`; this answers the same question from the store's lifetime records.
//! What it answers: rust/docs/store/collate-belief-reads.md.
//!
//! The writes the ledger makes over the table are served too (`readOpenLifetimes`, `mintLifetime`,
//! `endLifetime`, `renameLifetime`, `readMovedLifetimes`; `src/core/engine-sql/collate-belief-lifetimes.ts`),
//! so a belief batch can mint, end and rename a page's lifetime as the SQL engines do. Nothing
//! calls them in a shipped brain until `readLedgerSource` reports coverage.
//!
//! A removed source keeps its lifetimes, as the SQL table (no foreign key) does; the read joins the
//! source's current incarnation, so they answer nothing once the source is gone or recreated.
//!
//! Keys (under `keys::FACT`, `F`, with a sub-tag the facts records do not use; a text part ends
//! with a NUL byte, and no text column may hold one):
//! - `F 0x20 <source> 0x00 <slug> 0x00 <page lifetime uuid>` -> `LifetimeRecord` (JSON). A scan of
//!   one source meets its lifetimes in slug byte order, and one slug's in uuid text order.
//! - `F 0x26 <page lifetime uuid>` -> the lifetime's key above: `end` and `rename` name a lifetime by
//!   uuid alone, and a rename moves the record to its new slug's key.

use crate::belief_events::event_lifetimes;
use crate::env::is_uuid;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{read_page, read_page_by_id};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a belief page lifetime.
const LIFETIME: u8 = 0x20;
/// The byte after `keys::FACT` that marks the uuid -> lifetime key index.
const LIFETIME_BY_UUID: u8 = 0x26;

/// One `belief_page_lifetimes` row. `page_id` is the hint the SQL column keeps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LifetimeRecord {
    pub page_lifetime: String,
    pub source_id: String,
    pub source_incarnation: String,
    pub slug: String,
    pub page_id: Option<u64>,
    pub started_at_us: i64,
    pub ended_at_us: Option<i64>,
}

/// One orphan finding (`reason` is `no_page`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrphanLifetime {
    pub slug: String,
    pub page_lifetime: String,
    pub reason: String,
}

/// One open lifetime as `readOpenLifetimes` returns it (`LifetimeRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenLifetime {
    pub page_lifetime: String,
    pub source_incarnation: String,
    pub slug: String,
    pub page_id: Option<u64>,
}

/// An open lifetime whose page now sits at the lifetime's slug (`readMovedLifetimes`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MovedLifetime {
    pub page_id: u64,
    pub source_incarnation: String,
    pub page_lifetime: String,
}

/// The orphan lifetimes of a source: the total and the first `limit` by byte order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrphanLifetimes {
    pub total: usize,
    pub rows: Vec<OrphanLifetime>,
}

fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::FACT, LIFETIME];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key
}

pub(crate) fn lifetime_key(source_id: &str, slug: &str, page_lifetime: &str) -> Vec<u8> {
    let mut key = source_prefix(source_id);
    key.extend_from_slice(slug.as_bytes());
    key.push(0);
    key.extend_from_slice(page_lifetime.as_bytes());
    key
}

fn index_key(page_lifetime: &str) -> Vec<u8> {
    let mut key = vec![keys::FACT, LIFETIME_BY_UUID];
    key.extend_from_slice(page_lifetime.as_bytes());
    key
}

/// Writes a lifetime record and the index entry that finds it by uuid.
pub(crate) fn put_lifetime(tx: &mut dyn KvWrite, record: &LifetimeRecord) -> Result<()> {
    let key = lifetime_key(&record.source_id, &record.slug, &record.page_lifetime);
    put_json(tx, &key, record)?;
    tx.put(&index_key(&record.page_lifetime), &key)
}

/// A uuid as Postgres compares it: validated, lower case.
fn uuid(op: &str, name: &str, text: &str) -> Result<String> {
    if is_uuid(text) {
        Ok(text.to_ascii_lowercase())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: {name} is not a uuid: {text}"
        )))
    }
}

/// The lifetimes of one slug of a source, ended ones included, in uuid order.
fn lifetimes_at(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Vec<LifetimeRecord>> {
    let mut found = Vec::new();
    let mut failure = None;
    scan_prefix(
        read,
        &lifetime_key(source_id, slug, ""),
        false,
        &mut |_, v| {
            match serde_json::from_slice::<LifetimeRecord>(v) {
                Ok(l) => found.push(l),
                Err(e) => {
                    failure = Some(e);
                    return false;
                }
            }
            true
        },
    )?;
    match failure {
        Some(e) => Err(e.into()),
        None => Ok(found),
    }
}

/// The open lifetime at (incarnation, slug) of the source: the table's open-slug unique index.
fn open_at(
    read: &dyn KvRead,
    source_id: &str,
    incarnation: &str,
    slug: &str,
) -> Result<Option<LifetimeRecord>> {
    Ok(lifetimes_at(read, source_id, slug)?
        .into_iter()
        .find(|l| l.ended_at_us.is_none() && l.source_incarnation == incarnation))
}

/// The record a uuid names, or none.
fn by_uuid(read: &dyn KvRead, page_lifetime: &str) -> Result<Option<LifetimeRecord>> {
    match read.get(&index_key(page_lifetime))? {
        Some(key) => get_json(read, &key),
        None => Ok(None),
    }
}

impl Store {
    /// `readOpenLifetimes(sourceId, needs)`: the open lifetime at each (incarnation, slug) pair;
    /// `incarnations[i]` pairs with `slugs[i]`. A pair with none open answers nothing.
    pub fn read_open_lifetimes(
        &self,
        source_id: &str,
        incarnations: &[String],
        slugs: &[String],
    ) -> Result<Vec<OpenLifetime>> {
        const OP: &str = "readOpenLifetimes";
        no_nul(OP, &[("sourceId", source_id)])?;
        if incarnations.len() != slugs.len() {
            return Err(StoreError::invalid(format!(
                "{OP}: {} incarnations for {} slugs",
                incarnations.len(),
                slugs.len()
            )));
        }
        let read = self.read()?;
        let mut seen = std::collections::BTreeSet::new();
        let mut rows = Vec::new();
        for (incarnation, slug) in incarnations.iter().zip(slugs) {
            no_nul(OP, &[("slug", slug)])?;
            let incarnation = uuid(OP, "incarnation", incarnation)?;
            if !seen.insert((incarnation.clone(), slug.clone())) {
                continue;
            }
            if let Some(l) = open_at(&*read, source_id, &incarnation, slug)? {
                rows.push(OpenLifetime {
                    page_lifetime: l.page_lifetime,
                    source_incarnation: l.source_incarnation,
                    slug: l.slug,
                    page_id: l.page_id,
                });
            }
        }
        Ok(rows)
    }

    /// `endLifetime(lifetime)`: closes the lifetime when it is open; an unknown or closed one is
    /// left as it is.
    pub fn end_lifetime(&self, page_lifetime: &str) -> Result<()> {
        let page_lifetime = uuid("endLifetime", "lifetime", page_lifetime)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(mut record) = by_uuid(&*tx, &page_lifetime)?
                && record.ended_at_us.is_none()
            {
                record.ended_at_us = Some(now);
                put_lifetime(tx, &record)?;
            }
            Ok(())
        })
    }

    /// `mintLifetime(need)`: an open lifetime for the page at (incarnation, slug), or the one
    /// already open there (`ON CONFLICT DO NOTHING`, then a read); returns its uuid.
    pub fn mint_lifetime(
        &self,
        source_id: &str,
        incarnation: &str,
        slug: &str,
        page_id: u64,
    ) -> Result<String> {
        const OP: &str = "mintLifetime";
        no_nul(OP, &[("sourceId", source_id), ("slug", slug)])?;
        let incarnation = uuid(OP, "incarnation", incarnation)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(open) = open_at(&*tx, source_id, &incarnation, slug)? {
                return Ok(open.page_lifetime);
            }
            let record = LifetimeRecord {
                page_lifetime: self.env.new_uuid().to_ascii_lowercase(),
                source_id: source_id.to_string(),
                source_incarnation: incarnation,
                slug: slug.to_string(),
                page_id: Some(page_id),
                started_at_us: now,
                ended_at_us: None,
            };
            put_lifetime(tx, &record)?;
            Ok(record.page_lifetime)
        })
    }

    /// `renameLifetime(lifetime, slug, pageId)`: moves the lifetime to the slug and page hint. An
    /// open lifetime may not take a slug another lifetime holds open at the same incarnation
    /// (the open-slug unique index); an unknown uuid changes nothing.
    pub fn rename_lifetime(&self, page_lifetime: &str, slug: &str, page_id: u64) -> Result<()> {
        const OP: &str = "renameLifetime";
        no_nul(OP, &[("slug", slug)])?;
        let page_lifetime = uuid(OP, "lifetime", page_lifetime)?;
        self.write(|tx| {
            let Some(mut record) = by_uuid(&*tx, &page_lifetime)? else {
                return Ok(());
            };
            if record.ended_at_us.is_none() {
                let taken = open_at(&*tx, &record.source_id, &record.source_incarnation, slug)?;
                if taken.is_some_and(|t| t.page_lifetime != record.page_lifetime) {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "duplicate key value violates unique constraint \"belief_page_lifetimes_open\"",
                    ));
                }
            }
            tx.delete(&lifetime_key(
                &record.source_id,
                &record.slug,
                &record.page_lifetime,
            ))?;
            record.slug = slug.to_string();
            record.page_id = Some(page_id);
            put_lifetime(tx, &record)
        })
    }

    /// `readMovedLifetimes(pageIds)`: the open lifetimes whose page hint names a page that sits at
    /// the lifetime's slug now, in page id order.
    pub fn read_moved_lifetimes(&self, page_ids: &[u64]) -> Result<Vec<MovedLifetime>> {
        let read = self.read()?;
        let ids: std::collections::BTreeSet<u64> = page_ids.iter().copied().collect();
        let mut moved = Vec::new();
        for id in ids {
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            for l in lifetimes_at(&*read, &page.source_id, &page.slug)? {
                if l.ended_at_us.is_none() && l.page_id == Some(id) {
                    moved.push(MovedLifetime {
                        page_id: id,
                        source_incarnation: l.source_incarnation,
                        page_lifetime: l.page_lifetime,
                    });
                }
            }
        }
        Ok(moved)
    }

    /// `listOrphanLifetimes(sourceId, limit, deep)`: the open lifetimes of the source's current
    /// incarnation whose slug has no page row (a soft-deleted page is a row; reason `no_page`) and, when
    /// `deep`, the lifetimes the source's events name that no lifetime record holds, in any source (reason
    /// `no_lifetime`, one row for each slug and lifetime). Ordered by slug and lifetime bytes, at most
    /// `max(1, limit)` of them, with the count of all of them.
    pub fn list_orphan_lifetimes(
        &self,
        source_id: &str,
        limit: usize,
        deep: bool,
    ) -> Result<OrphanLifetimes> {
        no_nul("listOrphanLifetimes", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let source = read_source(&*read, source_id)?;
        let mut found = Vec::new();
        let mut known = BTreeSet::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::FACT, LIFETIME], false, &mut |_, v| {
            match serde_json::from_slice::<LifetimeRecord>(v) {
                Ok(l) => {
                    known.insert(l.page_lifetime.clone());
                    if l.source_id == source_id
                        && l.ended_at_us.is_none()
                        && source
                            .as_ref()
                            .is_some_and(|s| l.source_incarnation == s.incarnation)
                    {
                        found.push(l);
                    }
                }
                Err(e) => {
                    failure = Some(e);
                    return false;
                }
            }
            true
        })?;
        if let Some(e) = failure {
            return Err(e.into());
        }
        let mut orphans = Vec::new();
        for l in found {
            if read_page(&*read, source_id, &l.slug)?.is_none() {
                orphans.push(OrphanLifetime {
                    slug: l.slug,
                    page_lifetime: l.page_lifetime,
                    reason: "no_page".into(),
                });
            }
        }
        if deep {
            for (slug, page_lifetime) in event_lifetimes(&*read, source_id)? {
                if !known.contains(&page_lifetime) {
                    orphans.push(OrphanLifetime {
                        slug,
                        page_lifetime,
                        reason: "no_lifetime".into(),
                    });
                }
            }
        }
        orphans.sort_by(|a, b| {
            (a.slug.as_bytes(), a.page_lifetime.as_bytes())
                .cmp(&(b.slug.as_bytes(), b.page_lifetime.as_bytes()))
        });
        let total = orphans.len();
        orphans.truncate(limit.max(1));
        Ok(OrphanLifetimes {
            total,
            rows: orphans,
        })
    }
}
