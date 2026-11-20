//! Test-only seed writes for the Rust arm of the parity suite (compiled only with the `test-seeds`
//! feature, which the shipped addon build does not enable).
//!
//! PGLite and Postgres cases stamp a page column with a raw `UPDATE pages SET ...` that no
//! BrainEngine member performs: a shared `updated_at` (several pages written in one instant) and a
//! soft-deleted page carrying a file path. The store has no writer for either, so these two
//! methods give a Rust brain the same page. They are named in the notes of the change that added
//! them and are used only by `test/engine-parity/rust-arm.ts`.
//!
//! Keys: none of its own. Each rewrites the page record through `pages::write_page`.

use crate::Store;
use crate::error::{Result, StoreError};
use crate::pages::{read_page, write_page};

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
}
