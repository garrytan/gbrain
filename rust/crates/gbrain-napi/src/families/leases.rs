//! The lease members of the multi-user build (I-5): `acquireLease`, `renewLease`, `releaseLease`, `readLease` and
//! `assertLease`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::leases` call on the pool through `Brain::run`
//! and resolves plain JSON. A token is `{ name, epoch, token }`; a holder is `{ host_id, incarnation, writer_id }`. A
//! fence that fails rejects with code `lease_lost`, whose message is JSON `{ reason, name, epoch, current_epoch }`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::leases::LeaseToken;
use gbrain_store::write_origin::WriteOrigin;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcquireArgs {
    name: String,
    holder: WriteOrigin,
    ttl_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenewArgs {
    lease: LeaseToken,
    ttl_ms: u64,
}

#[napi]
impl Brain {
    /// `acquireLease({ name, holder, ttl_ms })`: resolves the token, or null while another holder's lease is live.
    #[napi]
    pub fn acquire_lease<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: AcquireArgs = required(args, "acquireLease args")?;
            s.acquire_lease(&a.name, &a.holder, a.ttl_ms)
        })
    }

    /// `renewLease({ lease, ttl_ms })`: resolves null; rejects `lease_lost` when the lease moved or was released.
    #[napi]
    pub fn renew_lease<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RenewArgs = required(args, "renewLease args")?;
            s.renew_lease(&a.lease, a.ttl_ms)
        })
    }

    /// `releaseLease(lease)`: resolves null; a stale token changes nothing.
    #[napi]
    pub fn release_lease<'env>(&self, env: &'env Env, lease: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let t: LeaseToken = required(lease, "releaseLease lease")?;
            s.release_lease(&t)
        })
    }

    /// `readLease(name)`: the stored lease without its token, with `live`, or null.
    #[napi]
    pub fn read_lease<'env>(&self, env: &'env Env, name: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_lease(&name))
    }

    /// `assertLease(lease)`: resolves null when the token holds its lease now (inside a bound transaction, as one of
    /// its statements); rejects `lease_lost` otherwise.
    #[napi]
    pub fn assert_lease<'env>(&self, env: &'env Env, lease: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let t: LeaseToken = required(lease, "assertLease lease")?;
            s.assert_lease(&t)
        })
    }
}
