//! Doctor reads: the typed members that replace the raw SQL of `gbrain doctor` checks
//! (SQL in `src/core/engine-sql/doctor-reads.ts`, docs in `rust/docs/store/cli-reads-doctor.md`).
//! Each read takes one snapshot and has no keys of its own.

use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::read_page_by_id;
use std::collections::HashMap;

/// Where a page-child relation keeps the page id in its keys: the key prefix and the byte offset
/// of the 8-byte page id after it. `None` for `tags`, which a page record holds inline.
fn child_page_id_index(target: &str) -> Result<Option<(&'static [u8], usize)>> {
    Ok(Some(match target {
        "page_versions.page_id" => (&[keys::VERSION], 1),
        "tags.page_id" => return Ok(None),
        "takes.page_id" => (&[keys::TAKE, 0x02], 2),
        "raw_data.page_id" => (&[keys::RAW_FILES, 0x01], 2),
        "timeline_entries.page_id" => (&[keys::TIMELINE], 1),
        "links.from_page_id" => (&[keys::LINK], 1),
        "links.to_page_id" => (&[keys::LINK_TO], 1),
        "links.origin_page_id" => (&[keys::LINK_ORIGIN], 1),
        "files.page_id" => (&[keys::RAW_FILES, 0x03], 2),
        other => {
            return Err(StoreError::invalid(format!(
                "countPageChildOrphans: '{other}' is not a page child target"
            )));
        }
    }))
}

/// Rows of `index` per page id, keyed by the page id the row names.
fn rows_per_page(read: &dyn KvRead, prefix: &[u8], at: usize) -> Result<HashMap<u64, u64>> {
    let mut per_page: HashMap<u64, u64> = HashMap::new();
    scan_prefix(read, prefix, false, &mut |key, _| {
        if let Some(id) = key.get(at..at + 8).and_then(keys::be8) {
            *per_page.entry(id).or_default() += 1;
        }
        true
    })?;
    Ok(per_page)
}

impl Store {
    /// `countPageChildOrphans(target)`: rows of a page-child relation (`<table>.<column>`, one of
    /// `PAGE_CHILD_FK_TARGETS` other than `content_chunks.page_id`) whose page id names no page.
    /// A NULL reference is not an orphan; the store keeps no index entry for one. `tags` are part
    /// of the page record, so they never outlive it.
    pub fn count_page_child_orphans(&self, target: &str) -> Result<u64> {
        let Some((prefix, at)) = child_page_id_index(target)? else {
            return Ok(0);
        };
        let read = self.read()?;
        let mut orphans = 0;
        for (page_id, n) in rows_per_page(&*read, prefix, at)? {
            if read_page_by_id(&*read, page_id)?.is_none() {
                orphans += n;
            }
        }
        Ok(orphans)
    }
}
