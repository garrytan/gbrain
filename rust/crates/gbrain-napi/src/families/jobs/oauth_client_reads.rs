//! Jobs: the `oauth_clients` reads of `engine-sql/collate-store-reads.ts` (rust/docs/store/oauth-clients.md). Same shape
//! as `spend_log.rs`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listClientsReferencingSource(sourceId)`: `{ clientId, clientName, deleted }` of every client of the source, by client id in byte order.
    #[napi]
    pub fn list_clients_referencing_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_clients_referencing_source(&source_id))
    }
}
