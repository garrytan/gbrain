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

    /// `readOwnerCredentials(memberId)`: `{ kind, id, name, row }` of every live client and token bound to the member, in byte order.
    #[napi]
    pub fn read_owner_credentials<'env>(
        &self,
        env: &'env Env,
        member_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_owner_credentials(&member_id))
    }
}
