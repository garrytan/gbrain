//! `deriveAccessPolicy(ctx)`: the store's own derivation of a caller's privacy policy
//! (`gbrain_store::access_derive`), for the multi-user self-check. Pure: no store, no I/O.
//!
//! A context the store cannot read answers `{"$invalid": <why>}` instead of throwing, so the
//! TypeScript self-check refuses the read (a mismatch) rather than failing open.

use napi_derive::napi;
use serde_json::{Value, json};

#[napi(js_name = "deriveAccessPolicy")]
pub fn derive_access_policy(ctx: Value) -> Value {
    match gbrain_store::access_derive::derive_json(&ctx) {
        Ok(v) => v,
        Err(e) => json!({ "$invalid": e.to_string() }),
    }
}
