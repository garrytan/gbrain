//! The page-write reads that belong to no other family: a source's state as a write reads it.
//! PGLite and Postgres run the SQL in `src/core/engine-sql/write-misc.ts`; this answers the same
//! question from the store's records. The link endpoint read is `link_queries`.
//!
//! What the store does not keep, and what the TypeScript members answer for it, is in
//! rust/docs/store/write_misc.md (shared skillpacks, chronicle state, access members and memory
//! proposals have no records here).
//!
//! Keys: none of its own. It reads the source records.

use crate::Store;
use crate::error::Result;
use crate::sources::read_source;
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

impl Store {
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
}
