//! The chronicle executor statements (`chronicleStore()`, `engine-sql/chronicle-executor.ts`): one binding that takes
//! the statement's name and its arguments as a JSON array, in the order of the TypeScript method
//! (rust/docs/store/chronicle-ledger.md, "Executor").

use gbrain_store::chronicle_ledger::{
    ChronicleCampaignQueue, ChronicleCandidates, ChronicleDiscovery, ChronicleFinish,
    ChronicleKeyTuple,
};
use gbrain_store::error::StoreError;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::store_binding::{Brain, required};

fn arg<T: DeserializeOwned>(args: &[Value], at: usize, what: &str) -> Result<T, StoreError> {
    required(args.get(at).cloned().unwrap_or(Value::Null), what)
}

#[napi]
impl Brain {
    /// `chronicleStore().<op>(...args)`: resolves what the statement answers.
    #[napi]
    pub fn chronicle_executor<'env>(
        &self,
        env: &'env Env,
        op: String,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: Vec<Value> = required(args, "chronicleStore arguments")?;
            let key = |at: usize| arg::<ChronicleKeyTuple>(&a, at, "chronicle row key");
            let text = |at: usize| arg::<String>(&a, at, "chronicleStore text argument");
            let texts = |at: usize| arg::<Vec<String>>(&a, at, "chronicleStore text list");
            let int = |at: usize| arg::<i64>(&a, at, "chronicleStore integer argument");
            Ok(match op.as_str() {
                "queueCampaignRow" => json!(s.chronicle_queue_campaign_row(&arg::<
                    ChronicleCampaignQueue,
                >(
                    &a,
                    0,
                    "campaign queue"
                )?)?),
                "campaignSpentUsd" => s.chronicle_campaign_spent_usd(&text(0)?)?,
                "failExhaustedCampaignRows" => {
                    s.chronicle_fail_exhausted_campaign_rows(int(0)? as i32)?;
                    Value::Null
                }
                "discoveryPages" => json!(s.chronicle_discovery_pages(&arg::<
                    ChronicleDiscovery,
                >(
                    &a, 0, "discovery"
                )?)?),
                "candidates" => json!(s.chronicle_candidates(&arg::<ChronicleCandidates>(
                    &a,
                    0,
                    "candidates"
                )?)?),
                "supersedeStaleRows" => {
                    s.chronicle_supersede_stale_rows()?;
                    Value::Null
                }
                "claim" => {
                    json!(s.chronicle_claim(&key(0)?, int(1)?, &text(2)?, int(3)? as i32)?)
                }
                "setNextAttempt" => {
                    s.chronicle_set_next_attempt(
                        &key(0)?,
                        arg::<Option<String>>(&a, 1, "next attempt")?,
                    )?;
                    Value::Null
                }
                "addAttemptCost" => {
                    s.chronicle_add_attempt_cost(
                        &key(0)?,
                        arg::<f64>(&a, 1, "cost")?,
                        int(2)? as i32,
                    )?;
                    Value::Null
                }
                "finish" => {
                    s.chronicle_finish(&key(0)?, &arg::<ChronicleFinish>(&a, 1, "outcome")?)?;
                    Value::Null
                }
                "latestJudged" => s.chronicle_latest_judged(
                    &text(0)?,
                    int(1)?,
                    int(2)? as i32,
                    &text(3)?,
                    &texts(4)?,
                    &text(5)?,
                )?,
                "inputFailures" => {
                    s.chronicle_input_failures(&text(0)?, int(1)?, int(2)? as i32, &text(3)?)?
                }
                "liveEventSlugs" => json!(s.chronicle_live_event_slugs(&text(0)?, &text(1)?)?),
                "eventProducers" => {
                    json!(s.chronicle_event_producers(&text(0)?, int(1)?, &texts(2)?)?)
                }
                "addAttempt" => json!(s.chronicle_add_attempt(&key(0)?)?),
                "liveEventHashes" => json!(s.chronicle_live_event_hashes(&text(0)?, &texts(1)?)?),
                "livePageId" => s.chronicle_live_page_id(&text(0)?, &text(1)?)?,
                "deleteEventTimeline" => {
                    s.chronicle_delete_event_timeline(&text(0)?, &text(1)?)?;
                    Value::Null
                }
                "eventTimelineEntry" => s.chronicle_event_timeline_entry(int(0)?, &text(1)?)?,
                "eventDiscriminators" => {
                    json!(s.chronicle_event_discriminators(&text(0)?, &texts(1)?)?)
                }
                other => {
                    return Err(StoreError::invalid(format!(
                        "chronicleStore: unknown statement {other:?}"
                    )));
                }
            })
        })
    }
}
