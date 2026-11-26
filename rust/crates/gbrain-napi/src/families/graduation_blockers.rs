//! The engine graduation drain's blocker reads: one `#[napi] impl Brain` block over
//! `gbrain_store::persistence::graduation_blockers` (src/core/rust-engine/store-members/graduation-drain.ts).
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON rows.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listGraduationPendingRequests()`: the requests in flight or under recovery, by sequence.
    #[napi]
    pub fn list_graduation_pending_requests<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_graduation_pending_requests())
    }

    /// `listGraduationTopologyRecoveries()`: the topology changes under recovery, oldest first.
    #[napi]
    pub fn list_graduation_topology_recoveries<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_graduation_topology_recoveries())
    }

    /// `listGraduationEffectRecoveries()`: the effects under recovery, by id.
    #[napi]
    pub fn list_graduation_effect_recoveries<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_graduation_effect_recoveries())
    }

    /// `listForeignHostBindings(hostId)`: the host bindings of every other host.
    #[napi]
    pub fn list_foreign_host_bindings<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_foreign_host_bindings(&host_id))
    }

    /// `listDanglingOAuthClients()` (napi name `listDanglingOauthClients`): the clients bound to a missing source.
    #[napi]
    pub fn list_dangling_oauth_clients<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_dangling_oauth_clients())
    }
}
