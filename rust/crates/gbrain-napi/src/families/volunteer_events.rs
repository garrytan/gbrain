//! Volunteered-page events: the insert and usage members of `engine-sql/collate-store-reads.ts`
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
}
