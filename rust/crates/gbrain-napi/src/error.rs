//! Typed errors for the binding.
//!
//! Every error that reaches JavaScript carries a stable `code` string, never just a message.
//! This file holds no JavaScript types, so the rules here are covered by plain `cargo test`.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};

/// The caller asked for the task to stop and it did.
pub const CANCELLED: &str = "cancelled";
/// A Rust panic or an unexpected failure inside the engine. The process keeps running.
pub const INTERNAL_ERROR: &str = "internal_error";
/// The pool is shutting down or closed and takes no new work.
pub const ENGINE_SHUTDOWN: &str = "engine_shutdown";

/// Extra data an error can carry next to its code, readable as a property in JavaScript.
#[derive(Debug, Clone, PartialEq)]
pub enum Detail {
    Count(u32),
    Flag(bool),
    Text(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskError {
    pub code: &'static str,
    pub message: String,
    pub details: Vec<(&'static str, Detail)>,
}

static DIAGNOSTIC: AtomicU64 = AtomicU64::new(1);

impl TaskError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Vec::new(),
        }
    }

    pub fn with(mut self, key: &'static str, detail: Detail) -> Self {
        self.details.push((key, detail));
        self
    }

    pub fn cancelled(completed_steps: u32, started: bool) -> Self {
        Self::new(CANCELLED, "the task was cancelled")
            .with("completedSteps", Detail::Count(completed_steps))
            .with("started", Detail::Flag(started))
    }

    pub fn shutdown() -> Self {
        Self::new(
            ENGINE_SHUTDOWN,
            "the engine is shut down and accepts no new work",
        )
    }

    /// The panic text goes to stderr through the panic hook, not into the error: a panic message
    /// can name paths or values the caller must not see. The diagnostic id ties the two together.
    pub fn internal() -> Self {
        let id = format!(
            "gbrain-{}-{}",
            std::process::id(),
            DIAGNOSTIC.fetch_add(1, Ordering::Relaxed)
        );
        Self::new(
            INTERNAL_ERROR,
            "the Rust engine hit an internal error; the process is still running",
        )
        .with("diagnosticId", Detail::Text(id))
    }
}

/// Run `work` and turn a panic into an `internal_error`. Every exported function and every task
/// on the worker pool goes through this, because a panic that unwinds into the Node-API
/// boundary ends the process.
pub fn guard<T>(work: impl FnOnce() -> Result<T, TaskError>) -> Result<T, TaskError> {
    match catch_unwind(AssertUnwindSafe(work)) {
        Ok(result) => result,
        Err(payload) => {
            drop_payload(payload);
            Err(TaskError::internal())
        }
    }
}

fn drop_payload(payload: Box<dyn Any + Send>) {
    // A payload's own destructor may panic; that must not escape either.
    let _ = catch_unwind(AssertUnwindSafe(move || drop(payload)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_becomes_internal_error_with_a_diagnostic_id() {
        let result: Result<(), TaskError> = guard(|| panic!("boom with /home/someone/secret"));
        let error = result.expect_err("a panic is an error");
        assert_eq!(error.code, INTERNAL_ERROR);
        assert!(
            !error.message.contains("secret"),
            "the panic text must not leak"
        );
        assert!(
            error
                .details
                .iter()
                .any(|(key, detail)| *key == "diagnosticId"
                    && matches!(detail, Detail::Text(id) if id.starts_with("gbrain-")))
        );
    }

    #[test]
    fn a_normal_result_and_a_typed_error_pass_through() {
        assert_eq!(guard(|| Ok::<_, TaskError>(7)), Ok(7));
        let error = guard::<()>(|| Err(TaskError::shutdown())).unwrap_err();
        assert_eq!(error.code, ENGINE_SHUTDOWN);
    }

    #[test]
    fn diagnostic_ids_are_unique() {
        let first = TaskError::internal();
        let second = TaskError::internal();
        assert_ne!(first.details, second.details);
    }
}
