//! Captured eval candidates and capture failures.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. Timestamps travel as ISO strings both ways; the shell makes them `Date`s.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `logEvalCandidate(input)`: resolves the new candidate's id.
    #[napi]
    pub fn log_eval_candidate<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::eval_capture::EvalCandidateInput =
                required(input, "logEvalCandidate input")?;
            s.log_eval_candidate(&input)
        })
    }

    /// `listEvalCandidates({ since?, limit?, tool? }?)`: newest first; `since` is an ISO string.
    #[napi]
    pub fn list_eval_candidates<'env>(
        &self,
        env: &'env Env,
        filter: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_eval_candidates(&arg(filter, "listEvalCandidates filter")?)
        })
    }

    /// `deleteEvalCandidatesBefore(date)`: `date` is an ISO string; resolves the count deleted.
    #[napi]
    pub fn delete_eval_candidates_before<'env>(
        &self,
        env: &'env Env,
        date: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_eval_candidates_before(&date))
    }

    /// `logEvalCaptureFailure(reason)`: resolves null.
    #[napi]
    pub fn log_eval_capture_failure<'env>(
        &self,
        env: &'env Env,
        reason: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.log_eval_capture_failure(reason.as_deref()))
    }

    /// `listEvalCaptureFailures({ since? }?)`: newest first; `since` is an ISO string.
    #[napi]
    pub fn list_eval_capture_failures<'env>(
        &self,
        env: &'env Env,
        filter: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_eval_capture_failures(&arg(filter, "listEvalCaptureFailures filter")?)
        })
    }
}
