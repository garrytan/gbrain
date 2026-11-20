//! Test-only seed writes for the Rust arm of the parity suite (compiled only with the `test-seeds`
//! feature, which the shipped addon build does not enable).
//!
//! PGLite and Postgres cases stamp a page column with a raw `UPDATE pages SET ...` that no
//! BrainEngine member performs: a shared `updated_at` (several pages written in one instant) and a
//! soft-deleted page carrying a file path. The store has no writer for either, so these two
//! methods give a Rust brain the same page. They are named in the notes of the change that added
//! them and are used only by `test/engine-parity/rust-arm.ts`.
//!
//! A third seed gives a Rust brain the belief ledger's page lifetimes (`belief_ledger.rs`), which
//! the SQL engines mint through `enableBeliefLedger` and no store writer serves yet.
//!
//! Keys: only the lifetimes' (`belief_ledger.rs`). The page seeds rewrite the page record through
//! `pages::write_page`.

use crate::Store;
use crate::belief_ledger::{LifetimeRecord, lifetime_key};
use crate::error::{Result, StoreError};
use crate::kv::scan_prefix;
use crate::pages::{read_page, write_page};
use crate::put_json;
use crate::sources::require_source;

impl Store {
    /// `UPDATE pages SET updated_at = <micros> WHERE source_id = $1 AND slug = $2`.
    pub fn seed_page_updated_at(
        &self,
        source_id: &str,
        slug: &str,
        updated_at_us: i64,
    ) -> Result<()> {
        self.write(|tx| {
            let mut page = read_page(&*tx, source_id, slug)?
                .ok_or_else(|| StoreError::invalid(format!("no page {source_id}/{slug}")))?;
            page.updated_at_us = updated_at_us;
            write_page(tx, &page)
        })
    }

    /// `UPDATE pages SET source_path = $3, deleted_at = $4 WHERE source_id = $1 AND slug = $2`:
    /// `None` is SQL NULL.
    pub fn seed_page_origin(
        &self,
        source_id: &str,
        slug: &str,
        source_path: Option<&str>,
        deleted_at_us: Option<i64>,
    ) -> Result<()> {
        self.write(|tx| {
            let mut page = read_page(&*tx, source_id, slug)?
                .ok_or_else(|| StoreError::invalid(format!("no page {source_id}/{slug}")))?;
            page.source_path = source_path.map(str::to_string);
            page.deleted_at_us = deleted_at_us;
            write_page(tx, &page)
        })
    }

    /// The lifetimes `enableBeliefLedger` mints for pages: one open `belief_page_lifetimes` row at
    /// the source's current incarnation for each slug that has a page and no open lifetime yet
    /// (`mintLifetime` is idempotent under the open-lifetime unique index). Returns the slugs it
    /// minted for.
    pub fn seed_belief_page_lifetimes(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<String>> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let incarnation = require_source(&*tx, source_id)?.incarnation;
            let mut minted = Vec::new();
            for slug in slugs {
                let page = read_page(&*tx, source_id, slug)?
                    .ok_or_else(|| StoreError::invalid(format!("no page {source_id}/{slug}")))?;
                // The key without its lifetime: the prefix of every lifetime of this slug.
                let prefix = lifetime_key(source_id, slug, "");
                let mut open = false;
                let mut failure = None;
                scan_prefix(&*tx, &prefix, false, &mut |_, v| {
                    match serde_json::from_slice::<LifetimeRecord>(v) {
                        Ok(l) => {
                            open |= l.ended_at_us.is_none() && l.source_incarnation == incarnation
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
                if open {
                    continue;
                }
                let record = LifetimeRecord {
                    page_lifetime: self.env.new_uuid(),
                    source_id: source_id.to_string(),
                    source_incarnation: incarnation.clone(),
                    slug: slug.clone(),
                    page_id: Some(page.id),
                    started_at_us: now,
                    ended_at_us: None,
                };
                put_json(
                    tx,
                    &lifetime_key(source_id, slug, &record.page_lifetime),
                    &record,
                )?;
                minted.push(slug.clone());
            }
            Ok(minted)
        })
    }
}
