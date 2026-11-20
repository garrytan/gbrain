//! The chronicle backfill batch, the campaign queue and spend, and the advisor's coverage-gap scan of
//! `engine-sql/chronicle-reads.ts` (rust/docs/store/chronicle-reads.md).

use gbrain_store::chronicle_reads::{ChronicleBackfillBatchQuery, ChronicleCampaignRowInput};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readChronicleBackfillBatch(q)`: the page rows (`effective_date` as ISO text), each with `done`.
    #[napi]
    pub fn read_chronicle_backfill_batch<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: ChronicleBackfillBatchQuery =
                required(query, "readChronicleBackfillBatch query")?;
            s.read_chronicle_backfill_batch(&query)
        })
    }

    /// `queueChronicleCampaignRow(w)`: resolves true when the row was queued.
    #[napi]
    pub fn queue_chronicle_campaign_row<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ChronicleCampaignRowInput = required(row, "queueChronicleCampaignRow row")?;
            s.queue_chronicle_campaign_row(&row)
        })
    }

    /// `readChronicleCampaignSpentUsd(campaignId)`: the campaign's recorded spend in USD.
    #[napi]
    pub fn read_chronicle_campaign_spent_usd<'env>(
        &self,
        env: &'env Env,
        campaign_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_chronicle_campaign_spent_usd(&campaign_id)
        })
    }

    /// `listChronicleCoverageGapPages()`: the page rows (`effective_date` as ISO text).
    #[napi]
    pub fn list_chronicle_coverage_gap_pages<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_chronicle_coverage_gap_pages())
    }
}
