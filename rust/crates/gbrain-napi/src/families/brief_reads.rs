//! The proactive brief's calendar, loop and page-edit reads, which the CLI made through
//! `executeRaw` (`src/core/engine-sql/brief-reads.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use gbrain_store::StoreError;
use gbrain_store::cli_reads::brief_reads::BriefEligibility;
use gbrain_store::facts::PrivacyPolicy;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

/// The optional policy a brief read applies; `null` applies none.
fn brief_policy(policy: Option<Value>, what: &str) -> gbrain_store::Result<Option<PrivacyPolicy>> {
    policy
        .filter(|v| !v.is_null())
        .map(|v| required::<PrivacyPolicy>(v, what))
        .transpose()
}

/// A JS number that must be a whole number at or above zero (an id, a byte ceiling, a limit).
fn whole(value: Value, what: &str) -> gbrain_store::Result<u64> {
    let n: f64 = required(value, what)?;
    if n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0 {
        Ok(n as u64)
    } else {
        Err(StoreError::invalid(format!(
            "{what}: {n} is not a whole number"
        )))
    }
}

#[napi]
impl Brain {
    /// `readBriefMeetingPages(sourceIds, startFrom, startTo, eligibility)`: the live meeting pages
    /// whose `start` text lies in the range, under the read floor policy and the eligibility.
    #[napi]
    pub fn read_brief_meeting_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        start_from: String,
        start_to: String,
        policy: Option<Value>,
        eligibility: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = brief_policy(policy, "readBriefMeetingPages policy")?;
            let eligibility: BriefEligibility =
                required(eligibility, "readBriefMeetingPages eligibility")?;
            s.read_brief_meeting_pages(
                &source_ids,
                &start_from,
                &start_to,
                policy.as_ref(),
                &eligibility,
            )
        })
    }

    /// `readBriefEmailAliasPages(sourceId, emails, eligibility)`: one row per alias row of the
    /// emails whose live page the policy and the eligibility admit.
    #[napi]
    pub fn read_brief_email_alias_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        emails: Vec<String>,
        policy: Option<Value>,
        eligibility: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = brief_policy(policy, "readBriefEmailAliasPages policy")?;
            let eligibility: BriefEligibility =
                required(eligibility, "readBriefEmailAliasPages eligibility")?;
            s.read_brief_email_alias_pages(&source_id, &emails, policy.as_ref(), &eligibility)
        })
    }

    /// `readBriefWorldFacts(factIds, eligibility)`: the active, world-visible, eligible facts
    /// among the ids that the fact policy does not hide.
    #[napi]
    pub fn read_brief_world_facts<'env>(
        &self,
        env: &'env Env,
        fact_ids: Vec<Value>,
        policy: Option<Value>,
        eligibility: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids = fact_ids
                .into_iter()
                .map(|v| whole(v, "readBriefWorldFacts factIds"))
                .collect::<gbrain_store::Result<Vec<_>>>()?;
            let policy = brief_policy(policy, "readBriefWorldFacts policy")?;
            let eligibility: BriefEligibility =
                required(eligibility, "readBriefWorldFacts eligibility")?;
            s.read_brief_world_facts(&ids, policy, &eligibility)
        })
    }

    /// `readBriefEditPage(sourceId, slug, maxBytes, opts)`: the live page under the policy and the
    /// eligibility, or null.
    #[napi]
    pub fn read_brief_edit_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        max_bytes: Value,
        policy: Option<Value>,
        eligibility: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let max_bytes = whole(max_bytes, "readBriefEditPage maxBytes")?;
            let policy = brief_policy(policy, "readBriefEditPage policy")?;
            let eligibility: BriefEligibility =
                required(eligibility, "readBriefEditPage eligibility")?;
            s.read_brief_edit_page(
                &source_id,
                &slug,
                max_bytes as i64,
                policy.as_ref(),
                &eligibility,
            )
        })
    }

    /// `readBriefTimelineEntry(pageId, since, opts)`: the page's newest entry since `since` under
    /// the event-page policy and the projection eligibility, or null.
    #[napi]
    pub fn read_brief_timeline_entry<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        since: String,
        policy: Option<Value>,
        eligibility: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id = whole(page_id, "readBriefTimelineEntry pageId")?;
            let policy = brief_policy(policy, "readBriefTimelineEntry policy")?;
            let eligibility: BriefEligibility =
                required(eligibility, "readBriefTimelineEntry eligibility")?;
            s.read_brief_timeline_entry(page_id, &since, policy.as_ref(), &eligibility)
        })
    }

    /// `readBriefPageVersions(pageId, since, maxBytes, limit)`: the page's newest revisions since
    /// `since`, by id descending.
    #[napi]
    pub fn read_brief_page_versions<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        since: String,
        max_bytes: Value,
        limit: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id = whole(page_id, "readBriefPageVersions pageId")?;
            let max_bytes = whole(max_bytes, "readBriefPageVersions maxBytes")?;
            let limit = whole(limit, "readBriefPageVersions limit")?;
            s.read_brief_page_versions(page_id, &since, max_bytes as i64, limit as usize)
        })
    }
}
