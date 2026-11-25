//! Jobs: the `pinned_questions` members of `engine-sql/pinned-questions.ts` (rust/docs/store/pinned-questions.md).

use gbrain_store::jobs::{PinFilter, PinInsert};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `insertPinnedQuestion(row)`: the new pin's row, or null when `(source_id, slug)` has one.
    #[napi]
    pub fn insert_pinned_question<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: PinInsert = required(row, "insertPinnedQuestion row")?;
            s.insert_pinned_question(&row)
        })
    }

    /// `readPinnedQuestion(sourceId, slug)`: the pin's row, or null.
    #[napi]
    pub fn read_pinned_question<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_pinned_question(&source_id, &slug))
    }

    /// `listPinnedQuestions(filter)`: the rows by source id in byte order, then by creation time and id.
    #[napi]
    pub fn list_pinned_questions<'env>(
        &self,
        env: &'env Env,
        filter: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: PinFilter = arg(filter, "listPinnedQuestions filter")?;
            s.list_pinned_questions(&filter)
        })
    }
}
