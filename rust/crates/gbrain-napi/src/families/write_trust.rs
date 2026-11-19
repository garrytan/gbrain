//! The write trust context (`gbrain_store::write_trust`): the store's stand-in for the
//! transaction-local trust settings `gbrain.write_trust_tier`, `gbrain.write_origin`,
//! `gbrain.write_trust_promotion`, `gbrain.write_trust_backfill`, `gbrain.write_trust_keep` and
//! `gbrain.write_open_facts`. The Rust engine's transaction sets it and clears it at commit or
//! rollback (docs/designs/RUST_ENGINE_INTERFACES.md, "Write trust context"); no BrainEngine member
//! maps to these methods on their own.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! The method decodes its argument, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `applyWriteTrust(names, values)`: sets each named write trust setting to the value at its
    /// index, all or nothing; resolves null. A name outside the six, or a value the trust rules
    /// refuse, rejects `invalid_argument`.
    #[napi]
    pub fn apply_write_trust<'env>(
        &self,
        env: &'env Env,
        names: Value,
        values: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let names: Vec<String> = required(names, "applyWriteTrust names")?;
            let values: Vec<String> = required(values, "applyWriteTrust values")?;
            s.apply_write_trust(&names, &values)
        })
    }

    /// `readWriteTrust(names)`: resolves the text each named setting was last set to, in `names`
    /// order, null where it was never set (`readTransactionSettings`).
    #[napi]
    pub fn read_write_trust<'env>(
        &self,
        env: &'env Env,
        names: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let names: Vec<String> = required(names, "readWriteTrust names")?;
            s.read_write_trust(&names)
        })
    }

    /// `clearWriteTrust()`: ends the context, as a transaction's end ends `SET LOCAL`; resolves
    /// null.
    #[napi]
    pub fn clear_write_trust<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.clear_write_trust();
            Ok(())
        })
    }
}
