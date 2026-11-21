//! The parks and owed-purge records of a derived-origin purge (src/core/engine-sql/origin-holds.ts): `listPurgeOrigins`,
//! `upsertDerivedOriginPark`, `recordOwedPurgeRows` and `deleteOriginHoldRows`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::persistence` call on the pool through `Brain::run` and
//! resolves plain JSON (src/core/rust-engine/store-members/page-purge-holds.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listPurgeOrigins(ids, recheckParked)`: resolves the pages among `ids` that are privacy origins, by id.
    #[napi]
    pub fn list_purge_origins<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
        recheck_parked: bool,
        honor_aliases: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_purge_origins(&ids, recheck_parked, honor_aliases)
        })
    }

    /// `upsertDerivedOriginPark(pageId, park)`: stores the park of the page; resolves null.
    #[napi]
    pub fn upsert_derived_origin_park<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        park: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.upsert_derived_origin_park(page_id, &park))
    }

    /// `recordOwedPurgeRows(pageId, requestId)`: resolves `{ owed, held }`, the rows written.
    #[napi]
    pub fn record_owed_purge_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.record_owed_purge_rows(page_id, &request_id))
    }

    /// `deleteOriginHoldRows(op, pageIds)`: resolves how many records of the op it removed.
    #[napi]
    pub fn delete_origin_hold_rows<'env>(
        &self,
        env: &'env Env,
        op: String,
        page_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_origin_hold_rows(&op, &page_ids))
    }
}
