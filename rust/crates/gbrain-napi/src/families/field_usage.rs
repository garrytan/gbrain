//! The field usage sample read of `gbrain schema detect --fields` (rust/docs/store/field-usage.md).
//!
//! The method decodes its argument, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `readFieldUsageSamples({ sourceId?, maxTypes, samplePerType })`: the live page types with
    /// their counts, most first, ties in byte order, and per type the frontmatter and
    /// compiled_truth of the oldest live pages.
    #[napi]
    pub fn read_field_usage_samples<'env>(
        &self,
        env: &'env Env,
        query: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_field_usage_samples(&arg(query, "readFieldUsageSamples query")?)
        })
    }
}
