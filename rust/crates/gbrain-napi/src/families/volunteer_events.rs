//! Context-volunteer events (store side: `gbrain_store::volunteer_events`, docs in
//! `rust/docs/store/volunteer-events.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use gbrain_store::volunteer_events::VolunteerEventInput;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertVolunteerEventRows(rows)`: how many rows were written (a page that is gone drops its rows).
    #[napi]
    pub fn insert_volunteer_event_rows<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<VolunteerEventInput> = required(rows, "insertVolunteerEventRows rows")?;
            s.insert_volunteer_event_rows(&rows)
        })
    }

    /// `listVolunteerChannels(sourceIds)`: `null` reads the whole brain.
    #[napi]
    pub fn list_volunteer_channels<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_volunteer_channels(source_ids.as_deref())
        })
    }

    /// `listVolunteerUsage(sourceIds, days)`.
    #[napi]
    pub fn list_volunteer_usage<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        days: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_volunteer_usage(&source_ids, days))
    }

    /// `deleteVolunteerEventsOlderThan(ttlDays)`: how many rows went.
    #[napi]
    pub fn delete_volunteer_events_older_than<'env>(
        &self,
        env: &'env Env,
        ttl_days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_volunteer_events_older_than(ttl_days))
    }

    /// `deleteVolunteerEventsForSlugs(sourceId, slugs)`: how many rows went.
    #[napi]
    pub fn delete_volunteer_events_for_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_volunteer_events_for_slugs(&source_id, &slugs)
        })
    }

    /// `countVolunteerEventsForSlug(sourceId, slug)`.
    #[napi]
    pub fn count_volunteer_events_for_slug<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_volunteer_events_for_slug(&source_id, &slug)
        })
    }
}
