//! The alias read link preparation made through `executeRaw`.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readLiveSlugAliases(sourceId, targets)`: resolves `[{ alias_slug, canonical_slug }]` for
    /// the targets that are alias slugs with no live page whose canonical page is live.
    #[napi]
    pub fn read_live_slug_aliases<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        targets: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let targets: Vec<String> = required(targets, "readLiveSlugAliases targets")?;
            s.read_live_slug_aliases(&source_id, &targets)
        })
    }
}
