//! Dream verdicts: the dream cycle's triage cache, keyed by `(filePath, contentHash)`.
//!
//! One `#[napi] impl Brain` block per family file; each method runs one `Store` call on the pool
//! through `Brain::run` and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `getDreamVerdict(filePath, contentHash)`: resolves the live verdict or null. `judged_at` is
    /// microsecond ISO text.
    #[napi]
    pub fn get_dream_verdict<'env>(
        &self,
        env: &'env Env,
        file_path: String,
        content_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_dream_verdict(&file_path, &content_hash))
    }

    /// `putDreamVerdict(filePath, contentHash, verdict)`: inserts or replaces; resolves null.
    #[napi]
    pub fn put_dream_verdict<'env>(
        &self,
        env: &'env Env,
        file_path: String,
        content_hash: String,
        verdict: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let verdict: gbrain_store::dream::DreamVerdictInput =
                required(verdict, "putDreamVerdict verdict")?;
            s.put_dream_verdict(&file_path, &content_hash, &verdict)
        })
    }

    /// `sweepDreamVerdicts()`: resolves the number of expired verdicts deleted.
    #[napi]
    pub fn sweep_dream_verdicts<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sweep_dream_verdicts())
    }
}
