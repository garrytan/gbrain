//! The synopsis tier's configuration read (src/core/engine-sql/synopsis-tier.ts): one
//! `#[napi] impl Brain` block over `gbrain_store::synopsis_tier`; rust/docs/store/synopsis-tier.md.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::synopsis_tier::SynopsisTierQuery;

#[napi]
impl Brain {
    /// `readSynopsisTierSources({ skipFrontmatter })`: the synopsis sources by id and whether
    /// trusted page frontmatter picks the tier.
    #[napi]
    pub fn read_synopsis_tier_sources<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SynopsisTierQuery = required(args, "readSynopsisTierSources args")?;
            s.read_synopsis_tier_sources(&a)
        })
    }
}
