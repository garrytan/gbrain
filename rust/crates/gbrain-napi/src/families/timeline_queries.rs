//! Timeline reads by date (the Life Chronicle reads) and event projections.
//!
//! Store methods for getTimelineForDate, getSince, getOnThisDay, getLastSeen and
//! upsertEventProjection.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `getTimelineForDate(date, { week?, limit?, sourceId?, sourceIds? }?)`:
    /// `ChronicleTimelineRow[]`, earliest first. `date` stays `YYYY-MM-DD`.
    #[napi]
    pub fn get_timeline_for_date<'env>(
        &self,
        env: &'env Env,
        date: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_timeline_for_date(&date, &arg(options, "getTimelineForDate options")?)
        })
    }

    /// `getSince(date, { kind?, limit?, sourceId?, sourceIds? }?)`: `ChronicleTimelineRow[]`,
    /// earliest first.
    #[napi]
    pub fn get_since<'env>(
        &self,
        env: &'env Env,
        date: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_since(&date, &arg(options, "getSince options")?)
        })
    }

    /// `getOnThisDay({ date?, limit?, sourceId?, sourceIds? }?)`: `ChronicleTimelineRow[]`,
    /// newest year first.
    #[napi]
    pub fn get_on_this_day<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_on_this_day(&arg(options, "getOnThisDay options")?)
        })
    }

    /// `getLastSeen(entitySlug, { asof?, sourceId?, sourceIds? }?)`: `{ last_date,
    /// last_event_slug }`; the shell adds `entity_slug` and `days_ago`.
    #[napi]
    pub fn get_last_seen<'env>(
        &self,
        env: &'env Env,
        entity_slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_last_seen(&entity_slug, &arg(options, "getLastSeen options")?)
        })
    }

    /// `upsertEventProjection({ depthSlug, eventSlug, date, summary, detail?, sourceId? })`:
    /// `{ projected }`.
    #[napi]
    pub fn upsert_event_projection<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_event_projection(&arg(Some(input), "upsertEventProjection options")?)
        })
    }
}
