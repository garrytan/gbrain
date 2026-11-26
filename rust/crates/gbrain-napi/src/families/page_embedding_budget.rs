//! The page embedding ledger on the paid path: the hold and ledger read, the hold record, the
//! approval that opens a hold, the grant and the settle (`gbrain_store::page_embedding_budget`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readPageEmbeddingBudget(pageId)`: the hold marker and the ledger row, all null when absent.
    #[napi]
    pub fn read_page_embedding_budget<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_embedding_budget(required(page_id, "readPageEmbeddingBudget pageId")?)
        })
    }

    /// `recordPageEmbeddingHold(pageId, reason)`: a held row for a page with no row yet.
    #[napi]
    pub fn record_page_embedding_hold<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        reason: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "recordPageEmbeddingHold pageId")?;
            let reason: String = required(reason, "recordPageEmbeddingHold reason")?;
            s.record_page_embedding_hold(page_id, &reason)
        })
    }

    /// `openPageEmbeddingHold(pageId)`: opens the page's row.
    #[napi]
    pub fn open_page_embedding_hold<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.open_page_embedding_hold(required(page_id, "openPageEmbeddingHold pageId")?)
        })
    }

    /// `reservePageEmbedding(pageId, input)`: one grant on the page's ledger row.
    #[napi]
    pub fn reserve_page_embedding<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "reservePageEmbedding pageId")?;
            s.reserve_page_embedding(page_id, &required(input, "reservePageEmbedding input")?)
        })
    }

    /// `settlePageEmbeddingReservation(pageId, settle)`: books a grant inside its window.
    #[napi]
    pub fn settle_page_embedding_reservation<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        settle: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "settlePageEmbeddingReservation pageId")?;
            s.settle_page_embedding_reservation(
                page_id,
                &required(settle, "settlePageEmbeddingReservation settle")?,
            )
        })
    }
}
