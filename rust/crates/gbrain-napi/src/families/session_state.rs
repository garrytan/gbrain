//! Ambient recall session state: the pack and delta reads, the cursor upsert, the checkpoint
//! manifest read and write, and the row GC (rust/docs/store/session_state.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readSessionContextState(sourceId, clientId, sessionId)`: resolves `{ standing_entities,
    /// surfaced_slugs, last_wake_at }`, or null with no row.
    #[napi]
    pub fn read_session_context_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        client_id: String,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_session_context_state(&source_id, &client_id, &session_id)
        })
    }

    /// `readDeltaSessionRow(sourceId, clientId, sessionId)`: resolves `{ surfaced_slugs,
    /// last_wake_at, facts_cursor_at, facts_cursor_id, degraded_wakes }`, or null with no row.
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

    /// `readCheckpointManifest(sourceId, clientId, sessionId)`: resolves `{ checkpoint_manifest }`,
    /// or null with no row.
    #[napi]
    pub fn read_checkpoint_manifest<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        client_id: String,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_checkpoint_manifest(&source_id, &client_id, &session_id)
        })
    }

    /// `upsertSessionContextRow(sourceId, clientId, sessionId, write)`: resolves the stored
    /// `degraded_wakes` (`SessionWrite`).
    #[napi]
    pub fn upsert_session_context_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        client_id: String,
        session_id: String,
        write: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let write: gbrain_store::session_state::SessionWrite =
                required(write, "upsertSessionContextRow write")?;
            s.upsert_session_context_row(&source_id, &client_id, &session_id, &write)
        })
    }

    /// `writeCheckpointManifest(sourceId, clientId, sessionId, manifest)`: replaces the manifest.
    #[napi]
    pub fn write_checkpoint_manifest<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        client_id: String,
        session_id: String,
        manifest: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_checkpoint_manifest(&source_id, &client_id, &session_id, manifest)
        })
    }

    /// `gcSessionContextRows(olderThanDays, maxRowsPerClient)`: the age and per-client cap
    /// deletes.
    #[napi]
    pub fn gc_session_context_rows<'env>(
        &self,
        env: &'env Env,
        older_than_days: f64,
        max_rows_per_client: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.gc_session_context_rows(older_than_days, max_rows_per_client)
        })
    }
}
