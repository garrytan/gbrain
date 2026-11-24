//! Doctor reads over the `sources` table (SQL in `src/core/engine-sql/doctor-sources.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-src.md`). The TypeScript side filters and projects the rows per
//! doctor check; the store answers every source with the columns those statements read, from one
//! snapshot, in id order.

use super::sources::scan_live_pages;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::sources::{SourceRecord, all_sources};
use crate::{Store, keys};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One source with the columns the doctor statements select. `last_commit`, `newest_content_at`
/// and the `upstream_*` columns are not here: the store keeps none of them, so the TypeScript side
/// answers them null.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DoctorSourceRow {
    pub id: String,
    pub name: Option<String>,
    pub local_path: Option<String>,
    pub archived: bool,
    pub config: Map<String, Value>,
    pub incarnation: String,
    pub last_sync_at: Option<String>,
    pub chunker_version: Option<String>,
}

/// Live and file-backed live pages of the `default` source: `{ live, file_backed }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DefaultSourceFiles {
    pub live: u64,
    pub file_backed: u64,
}

/// The two page fields the `default` source count reads.
#[derive(Deserialize)]
struct PageFile {
    #[serde(default)]
    deleted_at_us: Option<i64>,
    #[serde(default)]
    source_path: Option<String>,
}

fn doctor_row(r: SourceRecord) -> DoctorSourceRow {
    DoctorSourceRow {
        id: r.id,
        name: r.name,
        local_path: r.local_path,
        archived: r.archived,
        config: r.config,
        incarnation: r.incarnation,
        last_sync_at: r.last_sync_at_us.map(iso),
        chunker_version: r.chunker_version,
    }
}

fn has_live_page(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    let mut found = false;
    scan_live_pages(read, &keys::text(keys::PAGE, &[source_id, ""]), &mut |_| {
        found = true;
        false
    })?;
    Ok(found)
}

impl Store {
    /// Every source, archived ones included, by id (byte order, `default` not first).
    pub fn list_doctor_sources(&self) -> Result<Vec<DoctorSourceRow>> {
        let read = self.read()?;
        let mut sources = all_sources(&*read)?;
        sources.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(sources.into_iter().map(doctor_row).collect())
    }

    /// The ids, in id order, of the sources that hold at least one live page.
    pub fn list_source_ids_with_live_pages(&self) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut sources = all_sources(&*read)?;
        sources.sort_by(|a, b| a.id.cmp(&b.id));
        let mut ids = Vec::new();
        for source in sources {
            if has_live_page(&*read, &source.id)? {
                ids.push(source.id);
            }
        }
        Ok(ids)
    }

    /// Live pages of the `default` source, and how many of them record a source path.
    pub fn count_default_source_files(&self) -> Result<DefaultSourceFiles> {
        let read = self.read()?;
        let mut counts = DefaultSourceFiles {
            live: 0,
            file_backed: 0,
        };
        let mut failure: Option<StoreError> = None;
        scan_prefix(
            &*read,
            &keys::text(keys::PAGE, &[crate::sources::DEFAULT_SOURCE, ""]),
            false,
            &mut |_, v| match serde_json::from_slice::<PageFile>(v) {
                Ok(page) => {
                    if page.deleted_at_us.is_none() {
                        counts.live += 1;
                        counts.file_backed += u64::from(page.source_path.is_some());
                    }
                    true
                }
                Err(e) => {
                    failure = Some(e.into());
                    false
                }
            },
        )?;
        failure.map_or(Ok(counts), Err)
    }
}
