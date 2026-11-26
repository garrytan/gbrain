//! `readWithdrawalDiscovery`: the reads withdrawal discovery makes to find every page that carries a
//! withdrawn claim (src/core/facts/withdrawal-discovery.ts).
//!
//! One `#[napi] impl Brain` block; the method runs one `gbrain_store::facts::withdrawal_discovery`
//! call on the pool through `Brain::run` and resolves plain JSON rows. The TypeScript member
//! (src/core/rust-engine/store-members/withdrawal-discovery.ts) refuses what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::withdrawal_discovery::DiscoveryRead;

#[napi]
impl Brain {
    /// `readWithdrawalDiscovery(read)`: resolves the rows of one discovery read, tagged by `kind`.
    #[napi]
    pub fn read_withdrawal_discovery<'env>(
        &self,
        env: &'env Env,
        read: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: DiscoveryRead = required(read, "readWithdrawalDiscovery read")?;
            s.read_withdrawal_discovery(&q)
        })
    }
}
