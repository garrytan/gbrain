//! Session state: the session cursor and checkpoint manifest of context_pack and delta, keyed by
//! `(sourceId, clientId, sessionId)`.
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
    /// `upsertSessionState(sourceId, clientId, sessionId, write)`: resolves the row's
    /// `degraded_wakes` after the write.
    #[napi]
    pub fn upsert_session_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        client_id: String,
        session_id: String,
        write: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let write: gbrain_store::session_state::SessionStateWrite =
                required(write, "upsertSessionState write")?;
            s.upsert_session_state(&source_id, &client_id, &session_id, &write)
        })
    }

    /// `readSessionCursor(sourceId, clientId, sessionId)`: resolves the cursor row or null.
    #[napi]
    pub fn read_session_cursor<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        client_id: String,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_session_cursor(&source_id, &client_id, &session_id)
        })
    }

    /// `readDeltaSessionRow(sourceId, clientId, sessionId)`: resolves delta's row or null.
    #[napi]
    pub fn read_delta_session_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        client_id: String,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_delta_session_row(&source_id, &client_id, &session_id)
        })
    }
}
