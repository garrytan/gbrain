//! Retrieval feedback: the event, rating and status members of `engine-sql/retrieval-feedback.ts`
//! (rust/docs/store/retrieval-feedback.md).

use gbrain_store::retrieval_feedback::{RatingBatchInput, RetrievalEventInput};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertRetrievalEvents(events)`: records the events, their pages and links; resolves null.
    #[napi]
    pub fn insert_retrieval_events<'env>(
        &self,
        env: &'env Env,
        events: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let events: Vec<RetrievalEventInput> =
                required(events, "insertRetrievalEvents events")?;
            s.insert_retrieval_events(&events)
        })
    }

    /// `readRetrievalEvent(id)`: the event with its pages and links, or null.
    #[napi]
    pub fn read_retrieval_event<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_retrieval_event(&id))
    }

    /// `applyRetrievalRatings(args)`: the batch's ratings with the weights they hold.
    #[napi]
    pub fn apply_retrieval_ratings<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let batch: RatingBatchInput = required(args, "applyRetrievalRatings args")?;
            s.apply_retrieval_ratings(&batch)
        })
    }

    /// `readFeedbackStatus()`: the counts and the lowest and highest page weights.
    #[napi]
    pub fn read_feedback_status<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_feedback_status())
    }
}
