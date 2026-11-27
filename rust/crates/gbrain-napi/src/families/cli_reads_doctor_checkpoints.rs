//! The doctor checkpoint reads served from the store (`gbrain-store` `cli_reads::doctor_checkpoints`).
//! The TypeScript members (`src/core/rust-engine/store-members/doctor-checkpoints.ts`) answer the
//! relations the store keeps no writer for (rust/docs/store/cli-reads-doctor-checkpoints.md) without a call.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `writeDoctorLastKnown(op, rows)`: `{ op, rows: [{ entry, value }] }`.
    #[napi]
    pub fn write_doctor_last_known<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_doctor_last_known(&required(input, "writeDoctorLastKnown input")?)
        })
    }

    /// `readDoctorLastKnown(op)`: resolves `[{ fingerprint, entry }]`.
    #[napi]
    pub fn read_doctor_last_known<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_doctor_last_known(&op))
    }

    /// `readLatestConnectorReceipt()`: resolves the newest connector receipt's summary, or null.
    #[napi]
    pub fn read_latest_connector_receipt<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_latest_connector_receipt())
    }

    /// `listFactsAbsorbFailureGroups()`: resolves `[{ source_id, reason, n, newest }]`.
    #[napi]
    pub fn list_facts_absorb_failure_groups<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_facts_absorb_failure_groups())
    }

    /// `listDerivedOriginParks(op)`: `{ park }` for each park whose page is a tombstone, oldest first.
    #[napi]
    pub fn list_derived_origin_parks<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_derived_origin_parks(&op))
    }

    /// `readHeldHitRows({ holdOp, pageIds, sourceIds, types, terms, cap })`: the hits' hold rows, then
    /// `{ could_affect }`.
    #[napi]
    pub fn read_held_hit_rows<'env>(
        &self,
        env: &'env Env,
        query: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_held_hit_rows(&required(query, "readHeldHitRows query")?)
        })
    }
}
