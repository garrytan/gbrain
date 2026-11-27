//! The page-write reads that belong to no other family: a source's state as a write reads it, the
//! path attach of `sources add` (`attachSourcePath`), and the pages whose readers name a member or
//! a group (`listPagesNamingReader`, the `access member remove` and `access group remove` previews).
//! PGLite and Postgres run the SQL in `src/core/engine-sql/write-misc.ts`; this answers the same
//! question from the store's records. The link endpoint read is `link_queries`.
//!
//! What the store does not keep, and what the TypeScript members answer for it, is in
//! rust/docs/store/write_misc.md (shared skillpacks, chronicle state, access members and memory
//! proposals have no records here).
//!
//! Keys: none of its own. It reads the source and page records, and the path attach rewrites one.

use crate::error::Result;
use crate::facts::privacy::access_readers;
use crate::pages::all_pages;
use crate::sources::{read_source, source_key};
use crate::{Store, put_json};
use serde::Serialize;
use serde_json::{Map, Value};

/// A source as a write reads it (`SourceStateRow` of `src/core/engine-sql/write-misc.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceStateRow {
    pub incarnation: String,
    pub archived: bool,
    pub local_path: Option<String>,
    pub config: Map<String, Value>,
}

/// A page by slug and source (`PageNamingReaderRow` of `src/core/engine-sql/access-control.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageNamingReaderRow {
    pub slug: String,
    pub source_id: String,
}

impl Store {
    /// The pages in every source whose normalized readers (`gbrain_access_readers`, the
    /// `page_readers` column) name exactly `principal`, by (source, slug), at most `limit`. A
    /// soft-deleted page counts, as in the SQL (`FROM pages` with no deleted filter); a page with
    /// no `readable_by` key or an invalid one (`!nobody`) names no member or group. `live_only` leaves
    /// the soft-deleted pages out (`deleted_at IS NULL`, the `member disable` check).
    pub fn list_pages_naming_reader(
        &self,
        principal: &str,
        limit: u32,
        live_only: bool,
    ) -> Result<Vec<PageNamingReaderRow>> {
        let read = self.read()?;
        let mut rows: Vec<PageNamingReaderRow> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                (!live_only || p.deleted_at_us.is_none())
                    && access_readers(&p.frontmatter)
                        .is_some_and(|r| r.iter().any(|x| x == principal))
            })
            .map(|p| PageNamingReaderRow {
                slug: p.slug,
                source_id: p.source_id,
            })
            .collect();
        rows.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    /// `hasSynopsisFrontmatterOverride()`: whether a live markdown page of the `default` source, which is not archived,
    /// carries `contextual_retrieval: per_chunk_synopsis` in its frontmatter. The store keeps no
    /// `trust_frontmatter_overrides` (it reads as false, as `sources.rs` says), so the SQL's other arm, a source that
    /// trusts its pages' overrides, never holds here. `frontmatter @> '{"contextual_retrieval":"per_chunk_synopsis"}'`
    /// is string equality on that key.
    pub fn has_synopsis_frontmatter_override(&self) -> Result<bool> {
        let read = self.read()?;
        if read_source(&*read, "default")?.is_some_and(|source| source.archived) {
            return Ok(false);
        }
        Ok(all_pages(&*read)?.iter().any(|p| {
            p.source_id == "default"
                && p.deleted_at_us.is_none()
                && p.page_kind == "markdown"
                && p.frontmatter
                    .get("contextual_retrieval")
                    .and_then(Value::as_str)
                    == Some("per_chunk_synopsis")
        }))
    }

    /// The source's incarnation, archived flag, local path and config, or `None` for an unknown id.
    /// The SQL engines can hold the row FOR SHARE; the store runs one write transaction at a time,
    /// so no lock is needed and the TypeScript member drops the option.
    pub fn read_source_state(&self, source_id: &str) -> Result<Option<SourceStateRow>> {
        let read = self.read()?;
        Ok(read_source(&*read, source_id)?.map(|r| SourceStateRow {
            incarnation: r.incarnation,
            archived: r.archived,
            local_path: r.local_path,
            config: r.config,
        }))
    }

    /// Attaches a working tree to an existing source (`sources add --path` on a path-less row):
    /// sets `local_path`, replaces the name when `name` is given, and sets `config.federated` when
    /// `federated` is given. Every other field and config key is kept. Returns whether the source
    /// exists; an unknown id changes nothing. Mirrors `attachSourcePath`.
    pub fn attach_source_path(
        &self,
        source_id: &str,
        local_path: &str,
        name: Option<&str>,
        federated: Option<bool>,
    ) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, source_id)? else {
                return Ok(false);
            };
            crate::guest_sources::refuse_local_path_on_guest(&*tx, source_id)?;
            record.local_path = Some(local_path.to_owned());
            if let Some(name) = name {
                record.name = Some(name.to_owned());
            }
            if let Some(federated) = federated {
                record
                    .config
                    .insert("federated".into(), Value::Bool(federated));
            }
            put_json(tx, &source_key(source_id), &record)?;
            Ok(true)
        })
    }
}
