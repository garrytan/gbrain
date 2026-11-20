//! The page embedding lease and the per-page spend ledgers (`src/core/engine-sql/page-spend.ts`,
//! rust/docs/store/page_spend.md), each a thin call over `gbrain_store::jobs` (the lease) and
//! `gbrain_store::page_body` (the ledgers). `store-members/page-spend.ts` refuses a vector column
//! other than `embedding` before it calls here.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::jobs::LeaseHolder;
use gbrain_store::page_body::{
    BudgetLimitedPagesOpts, PageSpendLedger, PageSpendReservationWrite, PageSpendSettle,
};

#[napi]
impl Brain {
    /// `takePageEmbeddingLease(id, holder, ttlMinutes, token)`: whether this holder now has it.
    #[napi]
    pub fn take_page_embedding_lease<'env>(
        &self,
        env: &'env Env,
        id: String,
        holder: Value,
        ttl_minutes: f64,
        token: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let holder: LeaseHolder = required(holder, "takePageEmbeddingLease holder")?;
            s.take_page_embedding_lease(&id, &holder, ttl_minutes, &token)
        })
    }

    /// `renewPageEmbeddingLease(id, token, ttlMinutes)`: false when the row is gone.
    #[napi]
    pub fn renew_page_embedding_lease<'env>(
        &self,
        env: &'env Env,
        id: String,
        token: String,
        ttl_minutes: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.renew_page_embedding_lease(&id, &token, ttl_minutes)
        })
    }

    /// `releasePageEmbeddingLease(id, token)`.
    #[napi]
    pub fn release_page_embedding_lease<'env>(
        &self,
        env: &'env Env,
        id: String,
        token: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.release_page_embedding_lease(&id, &token))
    }

    /// `listVectorlessChunkIndexes(pageId, column)`.
    #[napi]
    pub fn list_vectorless_chunk_indexes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_vectorless_chunk_indexes(page_id))
    }

    /// `readPageEmbeddingHolds(pageId)`: `{ marker, state, reason }` or null.
    #[napi]
    pub fn read_page_embedding_holds<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_embedding_holds(page_id))
    }

    /// `writePageEmbeddingHold(pageId, reason, mode)`.
    #[napi]
    pub fn write_page_embedding_hold<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        reason: String,
        mode: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_page_embedding_hold(page_id, &reason, &mode)
        })
    }

    /// `openPageEmbeddingHold(pageId)`.
    #[napi]
    pub fn open_page_embedding_hold<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.open_page_embedding_hold(page_id))
    }

    /// `lockPageSpendLedger(ledger)`: the row, inserted when absent.
    #[napi]
    pub fn lock_page_spend_ledger<'env>(
        &self,
        env: &'env Env,
        ledger: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ledger: PageSpendLedger = required(ledger, "lockPageSpendLedger ledger")?;
            s.lock_page_spend_ledger(&ledger)
        })
    }

    /// `writePageSpendReservation(ledger, write)`: the reservation window, or null.
    #[napi]
    pub fn write_page_spend_reservation<'env>(
        &self,
        env: &'env Env,
        ledger: Value,
        write: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ledger: PageSpendLedger = required(ledger, "writePageSpendReservation ledger")?;
            let write: PageSpendReservationWrite =
                required(write, "writePageSpendReservation write")?;
            s.write_page_spend_reservation(&ledger, &write)
        })
    }

    /// `settlePageSpendReservation(ledger, { window, reservedUsd, bookedUsd, unpriced })`.
    #[napi]
    pub fn settle_page_spend_reservation<'env>(
        &self,
        env: &'env Env,
        ledger: Value,
        settle: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ledger: PageSpendLedger = required(ledger, "settlePageSpendReservation ledger")?;
            let settle: PageSpendSettle = required(settle, "settlePageSpendReservation settle")?;
            s.settle_page_spend_reservation(&ledger, &settle)
        })
    }

    /// `listBudgetLimitedPageRows(column, opts)`.
    #[napi]
    pub fn list_budget_limited_page_rows<'env>(
        &self,
        env: &'env Env,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: BudgetLimitedPagesOpts = required(opts, "listBudgetLimitedPageRows opts")?;
            s.list_budget_limited_page_rows(&opts)
        })
    }

    /// `readPageSizeStateRows(sourceId, slugs)`: `slugs` null reads every page of the source.
    #[napi]
    pub fn read_page_size_state_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let slugs: Option<Vec<String>> = required(slugs, "readPageSizeStateRows slugs")?;
            s.read_page_size_state_rows(&source_id, slugs.as_deref())
        })
    }
}
