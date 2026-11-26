//! Served positions: `commitPosition()`, the brain's published commit position for protocol v3
//! (docs/designs/rust-engine/multi-user-server.md, "M1 as built"; interfaces I-2 and I-7).
//!
//! Until per-transaction commit positions land (lane L2), this reads the store's durable commit
//! sequence. On the single-writer store every commit is alone in its batch, so the position
//! `{ sequence, index: 0 }` is exact there; on the optimistic store several transactions share a
//! sequence, so `exact` is false and the server returns no position.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::json;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `commitPosition()`: `{ sequence, index, exact }` of the latest published commit.
    #[napi]
    pub fn commit_position<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let sequence = s.commit_version()?;
            Ok(json!({ "sequence": sequence, "index": 0, "exact": s.occ_stats().is_none() }))
        })
    }
}
