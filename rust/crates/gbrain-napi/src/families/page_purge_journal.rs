//! The journal statements of a page purge's sweep and intent redaction (src/core/engine-sql/page-purge-journal.ts): the slug
//! read, the sequence ceiling, one chunk of the carrying predicate, the request lock, the effect byte sum, the redaction of
//! one request row and the counter release.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::persistence` call on the pool through `Brain::run` and
//! resolves plain JSON (src/core/rust-engine/store-members/page-purge-journal.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::persistence::{RedactRequestArgs, SweepChunkArgs};

#[napi]
impl Brain {
    /// `listRequestsForSlugs`: resolves the source's uncompacted requests under the slugs that still hold an intent, after a sequence.
    #[napi]
    pub fn list_requests_for_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        limit: i64,
        after: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_requests_for_slugs(&source_id, &slugs, limit, &after)
        })
    }

    /// `readJournalCeiling`: resolves the source's highest request sequence as text, or null.
    #[napi]
    pub fn read_journal_ceiling<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_journal_ceiling(&source_id))
    }

    /// `sweepJournalChunk(query)`: resolves one chunk of the carrying predicate.
    #[napi]
    pub fn sweep_journal_chunk<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SweepChunkArgs = required(args, "sweepJournalChunk args")?;
            s.sweep_journal_chunk(&a)
        })
    }

    /// `readEffectBytes`: resolves the bytes the request's effect rows hold on its receipt.
    #[napi]
    pub fn read_effect_bytes<'env>(
        &self,
        env: &'env Env,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_effect_bytes(&request_id))
    }

    /// `redactWriteRequestRow(redaction)`: removes the request's intent and error message and marks it compacted.
    #[napi]
    pub fn redact_write_request_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RedactRequestArgs = required(args, "redactWriteRequestRow args")?;
            s.redact_write_request_row(&a)
        })
    }

    /// `releaseTerminalBytes`: lowers a counter's terminal bytes.
    #[napi]
    pub fn release_terminal_bytes<'env>(
        &self,
        env: &'env Env,
        key: String,
        bytes: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.release_terminal_bytes(&key, bytes))
    }
}
