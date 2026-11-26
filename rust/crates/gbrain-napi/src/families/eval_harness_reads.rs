//! The memory-trust evals' harness reads: facts by id, live facts by exact text, every page with its
//! id, and the catalog reads and text scan (`gbrain_store::eval_harness_catalog`).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::eval_harness_reads` call on
//! the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/eval-harness-reads.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::eval_harness_catalog::TextScanQuery;
use gbrain_store::eval_harness_reads::{FactsByIdsQuery, LiveFactsByTextQuery};

#[napi]
impl Brain {
    /// `getFactsByIds({ ids })`: resolves each stored fact's identity, text and lifecycle, by id.
    #[napi]
    pub fn get_facts_by_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactsByIdsQuery = required(args, "getFactsByIds args")?;
            s.get_facts_by_ids(&a)
        })
    }

    /// `findLiveFactsByText({ sourceId, texts })`: resolves `{ id, fact }` of the source's live
    /// facts with one of the texts, by id.
    #[napi]
    pub fn find_live_facts_by_text<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LiveFactsByTextQuery = required(args, "findLiveFactsByText args")?;
            s.find_live_facts_by_text(&a)
        })
    }

    /// `listPageIdSlugs()`: resolves every page's `{ id, slug, source_id, deleted_at }`, by id.
    #[napi]
    pub fn list_page_id_slugs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_id_slugs())
    }

    /// `hasTable({ name })`: whether the store keeps records of that SQL table.
    #[napi]
    pub fn has_table<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TableArgs = required(args, "hasTable args")?;
            s.has_table(&a.table)
        })
    }

    /// `hasColumn({ table, column })`: whether that mapped table has the column.
    #[napi]
    pub fn has_column<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ColumnArgs = required(args, "hasColumn args")?;
            s.has_column(&a.table, &a.column)
        })
    }

    /// `listTextBearingColumns()`: resolves `{ table, column, data_type, udt_name }` of each text
    /// field the stored records carry.
    #[napi]
    pub fn list_text_bearing_columns<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_text_bearing_columns())
    }

    /// `scanTextColumns({ pattern, tables?, activeOnly, limit? })`: resolves each stored text value
    /// that contains the pattern.
    #[napi]
    pub fn scan_text_columns<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TextScanQuery = required(args, "scanTextColumns args")?;
            s.scan_text_columns(&a)
        })
    }

    /// `pauseManagedPersistence()`: turns managed persistence off with no epoch bump; resolves the
    /// prior `{ enabled, mode_epoch, topology_changes }`.
    #[napi]
    pub fn pause_managed_persistence<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.pause_managed_persistence())
    }

    /// `restoreManagedPersistence({ enabled, mode_epoch, topology_changes })`: the compare-and-set restore; resolves
    /// true when it wrote.
    #[napi]
    pub fn restore_managed_persistence<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RestoreArgs = required(args, "restoreManagedPersistence args")?;
            s.restore_managed_persistence(a.enabled, &a.mode_epoch, &a.topology_changes)
        })
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TableArgs {
    table: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnArgs {
    table: String,
    column: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreArgs {
    enabled: bool,
    mode_epoch: String,
    topology_changes: String,
}
