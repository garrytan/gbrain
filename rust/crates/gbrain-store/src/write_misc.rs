//! The page-write reads that belong to no other family: a source's state as a write reads it, and
//! the path attach of `sources add` (`attachSourcePath`).
//! PGLite and Postgres run the SQL in `src/core/engine-sql/write-misc.ts`; this answers the same
//! question from the store's records. The link endpoint read is `link_queries`.
//!
//! What the store does not keep, and what the TypeScript members answer for it, is in
//! rust/docs/store/write_misc.md (shared skillpacks, chronicle state, access members and memory
//! proposals have no records here).
//!
//! Keys: none of its own. It reads the source records, and the path attach rewrites one.

use crate::error::Result;
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
