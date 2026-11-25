//! The persistence consumer heartbeat rows of a Rust brain in multi-user mode: `listHostConsumerRows`,
//! `probeLiveConsumerRows`, `renewConsumerRow` and `deleteConsumerRow` (gbrain-store `consumers.rs`).
//!
//! One `#[napi] impl Brain` block; each method runs one store call on the pool through `Brain::run` and resolves plain
//! JSON in the SQL engines' row shape. The TypeScript members call them only when the brain reports `multiuser`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::consumers::{ConsumerProbe, ConsumerRenewal, ConsumerRowKey};

#[napi]
impl Brain {
    /// `listHostConsumerRows(hostId)`: the host's consumer rows, oldest first.
    #[napi]
    pub fn list_host_consumer_rows<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_host_consumer_rows(&host_id))
    }

    /// `probeLiveConsumerRows(probe)`: the host's live full consumers other than the caller.
    #[napi]
    pub fn probe_live_consumer_rows<'env>(
        &self,
        env: &'env Env,
        probe: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let p: ConsumerProbe = required(probe, "probeLiveConsumerRows probe")?;
            s.probe_live_consumer_rows(&p)
        })
    }

    /// `renewConsumerRow(renewal)`: purges the host's lapsed rows, then inserts or renews the caller's; resolves null.
    #[napi]
    pub fn renew_consumer_row<'env>(
        &self,
        env: &'env Env,
        renewal: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let r: ConsumerRenewal = required(renewal, "renewConsumerRow renewal")?;
            s.renew_consumer_row(&r)
        })
    }

    /// `deleteConsumerRow(key)`: deletes the caller's row; resolves null.
    #[napi]
    pub fn delete_consumer_row<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let k: ConsumerRowKey = required(key, "deleteConsumerRow key")?;
            s.delete_consumer_row(&k)
        })
    }
}
