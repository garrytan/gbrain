//! The access read log (gbrain-store `access_read_log`): the read-log writer's batched insert and retention prune,
//! and the reads of `gbrain access log` and `gbrain access who-read`
//! (src/core/rust-engine/store-members/access-read-log.ts).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use gbrain_store::access_read_log::{ReadLogPagesQuery, ReadLogQuery, ReadLogRowInput};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertAccessReadLogRows(rows)`: appends the rows in order; resolves null.
    #[napi]
    pub fn insert_access_read_log_rows<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<ReadLogRowInput> = required(rows, "insertAccessReadLogRows rows")?;
            s.insert_access_read_log_rows(&rows)
        })
    }

    /// `pruneAccessReadLog(days, maxRows)`: the retention prune; resolves null.
    #[napi]
    pub fn prune_access_read_log<'env>(
        &self,
        env: &'env Env,
        days: i64,
        max_rows: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prune_access_read_log(days, max_rows))
    }

    /// `readAccessReadLog({ since, member, limit })`: the logged reads, newest first.
    #[napi]
    pub fn read_access_read_log<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: ReadLogQuery = required(query, "readAccessReadLog query")?;
            s.read_access_read_log(&q)
        })
    }

    /// `listAccessReadPageRefs(slug, sourceId)`: `[{ id, source_id, slug }]` by source id.
    #[napi]
    pub fn list_access_read_page_refs<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_access_read_page_refs(&slug, source_id.as_deref())
        })
    }

    /// `readAccessReadsOfPages({ pageIds, since, limit })`: the logged reads of those pages, newest first.
    #[napi]
    pub fn read_access_reads_of_pages<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: ReadLogPagesQuery = required(query, "readAccessReadsOfPages query")?;
            s.read_access_reads_of_pages(&q)
        })
    }

    /// `tallyAccessReadsOfPages({ pageIds, since })`: `[{ who, reads, last_at }]`, latest reader first.
    #[napi]
    pub fn tally_access_reads_of_pages<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: ReadLogPagesQuery = required(query, "tallyAccessReadsOfPages query")?;
            s.tally_access_reads_of_pages(&q)
        })
    }
}
