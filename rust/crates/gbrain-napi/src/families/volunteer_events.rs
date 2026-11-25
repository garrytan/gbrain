//! Volunteered-page events: the insert and usage members of `engine-sql/volunteer-events.ts`
//! (rust/docs/store/volunteer-events.md).

use gbrain_store::volunteer_events::VolunteerEventInput;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertVolunteerEvents(rows)`: logs the rows whose page exists; resolves null.
    #[napi]
    pub fn insert_volunteer_events<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<VolunteerEventInput> = required(rows, "insertVolunteerEvents rows")?;
            s.insert_volunteer_events(&rows)
        })
    }

    /// `listVolunteerChannels(sourceIds)`: the event counts and newest time per channel over the last 7 days.
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

    /// `readVolunteerUsage(sourceIds, days)`: the volunteered and used counts per arm and channel.
    #[napi]
    pub fn read_volunteer_usage<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
        days: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "readVolunteerUsage sourceIds")?;
            s.read_volunteer_usage(&ids, days)
        })
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
}
