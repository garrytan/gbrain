//! Takes: the reads behind the doctor, onboarding, purge, fence import, scorecard, supersession
//! repair and calibration admin sites, the take trust reads, the reads and the delete of
//! `gbrain extract takes` (rust/docs/store/takes-reads.md), the two writes of the takes
//! publication's prepare step, the grade_takes verdict cache, the take horizons, and the wave
//! writes of `gbrain calibration --undo-wave` with the nudge log. Same shape as `../takes.rs`.

use gbrain_store::takes::{
    HeldFenceTakeSpec, IncomingTake, LiveTakeAt, McpResolvedInput, PurgeTakesInput,
    RevertResolutionsSpec, TakeGradeFilter, TakeGradeInput, TakeGradeKey, TakeHorizonInput,
    TakeNudgeFilter, TakeNudgeInput, TakePreimageInput, TakesLeavingFence, WaveSpec,
};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use super::whole;
use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `countOffGridTakeWeights()`: `{ off_grid, total }`.
    #[napi]
    pub fn count_off_grid_take_weights<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_off_grid_take_weights())
    }

    /// `countTakes()`: resolves the number of takes.
    #[napi]
    pub fn count_takes<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_takes())
    }

    /// `planFactPurgeTakes({ sourceId, factIds, factHash, subject })`: `[{ id, page_id }]`.
    #[napi]
    pub fn plan_fact_purge_takes<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: PurgeTakesInput = required(input, "planFactPurgeTakes input")?;
            s.plan_fact_purge_takes(&input)
        })
    }

    /// `listTakeRowsForPage(pageId)`: `[{ row_num, claim }]`.
    #[napi]
    pub fn list_take_rows_for_page<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_take_rows_for_page(whole(page_id, "pageId")?)
        })
    }

    /// `listHeldFenceTakeRows({ sourceId, kind, ownerKey, pageId })`: the page's takes while its fence generation is held.
    #[napi]
    pub fn list_held_fence_take_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: HeldFenceTakeSpec = required(spec, "listHeldFenceTakeRows spec")?;
            s.list_held_fence_take_rows(&spec)
        })
    }

    /// `readTakePreimages({ pageId, by, gone, incoming })`: `[{ preimage, gone }]` by row number.
    #[napi]
    pub fn read_take_preimages<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: TakePreimageInput = required(input, "readTakePreimages input")?;
            s.read_take_preimages(&input)
        })
    }

    /// `readTakeRowTrust(pageId, rowNum)`: `{ id, claim, trust_tier }` or null.
    #[napi]
    pub fn read_take_row_trust<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row_num: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_take_row_trust(whole(page_id, "pageId")?, whole(row_num, "rowNum")?)
        })
    }

    /// `readTakeTrustRef(id)`: `{ id, source_id, claim, trust_tier, write_origin, active,
    /// quarantined }` or null.
    #[napi]
    pub fn read_take_trust_ref<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_take_trust_ref(whole(id, "id")?))
    }

    /// `countMcpResolvedTakes({ sourceIds, holders, excludePrivate })`: resolves the count.
    #[napi]
    pub fn count_mcp_resolved_takes<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: McpResolvedInput = required(input, "countMcpResolvedTakes input")?;
            s.count_mcp_resolved_takes(&input)
        })
    }

    /// `listTakeSupersessionCandidates(sourceIds)`: `[{ id, source_id, slug }]`.
    #[napi]
    pub fn list_take_supersession_candidates<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_take_supersession_candidates(&source_ids)
        })
    }

    /// `listTakePointers(pageId)`: `[{ row_num, superseded_by }]`.
    #[napi]
    pub fn list_take_pointers<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.list_take_pointers(page),
            Err(_) => Ok(Vec::new()),
        })
    }

    /// `listTakeSupersedeReceipts(sourceId, pageId, slug)`: `[{ old_row, new_row }]`.
    #[napi]
    pub fn list_take_supersede_receipts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.list_take_supersede_receipts(&source_id, page, &slug),
            Err(_) => Ok(Vec::new()),
        })
    }

    /// `readTakeRowTier(pageId, rowNum)`: resolves `{ id, trust_tier }` of the take in that row, or null.
    #[napi]
    pub fn read_take_row_tier<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        row_num: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.read_take_row_tier(page, row_num),
            Err(_) => Ok(None),
        })
    }

    /// `hasTakeClaim(pageId, claim)`: resolves whether the page holds a take with that claim.
    #[napi]
    pub fn has_take_claim<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.has_take_claim(page, &claim),
            Err(_) => Ok(false),
        })
    }

    /// `listTakeRowNums(pageId)`: resolves the row numbers of the page's takes, ascending.
    #[napi]
    pub fn list_take_row_nums<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.list_take_row_nums(page),
            Err(_) => Ok(Vec::new()),
        })
    }

    /// `readTakeRowTierByClaim(pageId, rowNum, claim)`: resolves `{ id, trust_tier }`, or null.
    #[napi]
    pub fn read_take_row_tier_by_claim<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        row_num: i32,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.read_take_row_tier_by_claim(page, row_num, &claim),
            Err(_) => Ok(None),
        })
    }

    /// `setTakeSupersededBy(pageId, rowNum, supersededBy)`: resolves when the row is written.
    #[napi]
    pub fn set_take_superseded_by<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        row_num: i32,
        superseded_by: Option<i32>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.set_take_superseded_by(page, row_num, superseded_by),
            Err(_) => Ok(()),
        })
    }

    /// `listTopResolvedTakesForHolder(holder)`: the holder's 25 heaviest active resolved takes.
    #[napi]
    pub fn list_top_resolved_takes_for_holder<'env>(
        &self,
        env: &'env Env,
        holder: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_top_resolved_takes_for_holder(&holder))
    }

    /// `listAbandonedTakes()`: the five oldest abandoned high-conviction takes.
    #[napi]
    pub fn list_abandoned_takes<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_abandoned_takes())
    }

    /// `readLivePageIdBySlug(slug, sourceId)`: the id, or null.
    #[napi]
    pub fn read_live_page_id_by_slug<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_page_id_by_slug(&slug, &source_id))
    }

    /// `readPageTierRef(pageId)`: `{ source_id, slug, trust_tier }`, or null.
    #[napi]
    pub fn read_page_tier_ref<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_tier_ref(whole(page_id, "pageId")?)
        })
    }

    /// `readPageTierRows(ids)`: `[{ id, source_id, slug, trust_tier }]`.
    #[napi]
    pub fn read_page_tier_rows<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "readPageTierRows ids")?;
            s.read_page_tier_rows(&ids)
        })
    }

    /// `pageHasFrontmatterKey(pageId, key)`: resolves a boolean.
    #[napi]
    pub fn page_has_frontmatter_key<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.page_has_frontmatter_key(whole(page_id, "pageId")?, &key)
        })
    }

    /// `listTakeIdsLeavingFence(pageId, fence)`: the take ids.
    #[napi]
    pub fn list_take_ids_leaving_fence<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        fence: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: TakesLeavingFence = required(fence, "listTakeIdsLeavingFence fence")?;
            s.list_take_ids_leaving_fence(whole(page_id, "pageId")?, &fence)
        })
    }

    /// `listTakePreimages(pageId, ids, incoming)`: `[{ preimage, gone }]`.
    #[napi]
    pub fn list_take_preimages<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        ids: Value,
        incoming: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listTakePreimages ids")?;
            let incoming: Vec<IncomingTake> = required(incoming, "listTakePreimages incoming")?;
            s.list_take_preimages(whole(page_id, "pageId")?, &ids, &incoming)
        })
    }

    /// `deleteTakesByIds(ids)`: resolves when the takes are deleted.
    #[napi]
    pub fn delete_takes_by_ids<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "deleteTakesByIds ids")?;
            s.delete_takes_by_ids(&ids)
        })
    }

    /// `findTakeId(pageId, rowNum)`: the id, or null.
    #[napi]
    pub fn find_take_id<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row_num: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_take_id(whole(page_id, "pageId")?, whole(row_num, "rowNum")?)
        })
    }

    /// `listTakeHoldersAtRows(pageId, rowNums)`: the distinct holders at those row numbers, sorted.
    #[napi]
    pub fn list_take_holders_at_rows<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row_nums: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<i64> = row_nums
                .iter()
                .map(|n| whole(*n, "rowNums"))
                .collect::<Result<_, _>>()?;
            s.list_take_holders_at_rows(whole(page_id, "pageId")?, &rows)
        })
    }

    /// `stampTakeResolvedAt(pageId, rowNum, resolvedAt)`: resolves when the take's `resolved_at` is set.
    #[napi]
    pub fn stamp_take_resolved_at<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row_num: f64,
        resolved_at: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stamp_take_resolved_at(
                whole(page_id, "pageId")?,
                whole(row_num, "rowNum")?,
                &resolved_at,
            )
        })
    }

    /// `recordTakeHoldersUsed(requestId, holders)`: resolves when the request's
    /// `authority.takeHoldersUsed` is set.
    #[napi]
    pub fn record_take_holders_used<'env>(
        &self,
        env: &'env Env,
        request_id: String,
        holders: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let holders: Vec<String> = required(holders, "recordTakeHoldersUsed holders")?;
            s.record_take_holders_used(&request_id, &holders)
        })
    }

    /// `readTakeGrade({ takeId, promptVersion, judgeModelId, evidenceSignature })`:
    /// `{ verdict, confidence, applied }` or null.
    #[napi]
    pub fn read_take_grade<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: TakeGradeKey = required(input, "readTakeGrade key")?;
            s.read_take_grade(&key)
        })
    }

    /// `insertTakeGrade({ ...key, verdict, confidence, applied, gradedAt? })`: a row already at the key stays.
    #[napi]
    pub fn insert_take_grade<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: TakeGradeInput = required(input, "insertTakeGrade row")?;
            s.insert_take_grade(&row)
        })
    }

    /// `deleteTakeGrade(key)`: drops the cached verdict at the key.
    #[napi]
    pub fn delete_take_grade<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: TakeGradeKey = required(input, "deleteTakeGrade key")?;
            s.delete_take_grade(&key)
        })
    }

    /// `listLatestTakeGrades({ verdict, minConfidence, applied, limit })`: the newest verdict of each live take.
    #[napi]
    pub fn list_latest_take_grades<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: TakeGradeFilter = required(input, "listLatestTakeGrades filter")?;
            s.list_latest_take_grades(&filter)
        })
    }
    /// `readLiveTakePage({ pageId, rowNum, claim })`: `{ slug, source_id }` or null.
    #[napi]
    pub fn read_live_take_page<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let at: LiveTakeAt = required(input, "readLiveTakePage input")?;
            s.read_live_take_page(&at)
        })
    }

    /// `readTakeClaim(takeId)`: the claim, or null.
    #[napi]
    pub fn read_take_claim<'env>(
        &self,
        env: &'env Env,
        take_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_take_claim(whole(take_id, "takeId")?))
    }

    /// `upsertTakeHorizon({ takeId, claimSha256, horizonDate, basis })`: resolves when stored.
    #[napi]
    pub fn upsert_take_horizon<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let h: TakeHorizonInput = required(input, "upsertTakeHorizon input")?;
            s.upsert_take_horizon(&h)
        })
    }

    /// `deleteTakeHorizon(takeId)`: resolves true when the take had a horizon.
    #[napi]
    pub fn delete_take_horizon<'env>(
        &self,
        env: &'env Env,
        take_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_take_horizon(whole(take_id, "takeId")?)
        })
    }

    /// `listTakeHorizons(takeIds | null)`: `[{ take_id, horizon_date, basis, set_at, claim_sha256, claim }]`.
    #[napi]
    pub fn list_take_horizons<'env>(
        &self,
        env: &'env Env,
        take_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Option<Vec<i64>> = required(take_ids, "listTakeHorizons takeIds")?;
            s.list_take_horizons(ids.as_deref())
        })
    }

    /// `listHorizonScanRows(sourceId | null)`: `[{ id, claim, since_date, basis, claim_sha256, horizon_date }]`.
    #[napi]
    pub fn list_horizon_scan_rows<'env>(
        &self,
        env: &'env Env,
        source_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let source: Option<String> = required(source_id, "listHorizonScanRows sourceId")?;
            s.list_horizon_scan_rows(source.as_deref())
        })
    }

    /// `listWaveAppliedTakeIds(waveVersion)`: the take ids, ascending.
    #[napi]
    pub fn list_wave_applied_take_ids<'env>(
        &self,
        env: &'env Env,
        wave_version: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_wave_applied_take_ids(&wave_version))
    }

    /// `revertWaveTakeResolutions({ takeIds, resolvedBy, dryRun })`: the count.
    #[napi]
    pub fn revert_wave_take_resolutions<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: RevertResolutionsSpec = required(input, "revertWaveTakeResolutions spec")?;
            s.revert_wave_take_resolutions(&spec)
        })
    }

    /// `unapplyWaveTakeGrades({ waveVersion, dryRun })`: the count.
    #[napi]
    pub fn unapply_wave_take_grades<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: WaveSpec = required(input, "unapplyWaveTakeGrades spec")?;
            s.unapply_wave_take_grades(&spec)
        })
    }

    /// `listTakeNudges({ sourceId, takeId?, proposalId?, nudgePattern?, waveVersion? })`: the source's nudge rows, oldest first.
    #[napi]
    pub fn list_take_nudges<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let f: TakeNudgeFilter = required(input, "listTakeNudges filter")?;
            s.list_take_nudges(&f)
        })
    }

    /// `purgeTakeNudgesByWave({ waveVersion, dryRun })`: the count.
    #[napi]
    pub fn purge_take_nudges_by_wave<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: WaveSpec = required(input, "purgeTakeNudgesByWave spec")?;
            s.purge_take_nudges_by_wave(&spec)
        })
    }

    /// `insertTakeNudge({ sourceId, takeId?, proposalId?, nudgePattern, channel?, waveVersion?, firedAt? })`: the id.
    #[napi]
    pub fn insert_take_nudge<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let n: TakeNudgeInput = required(input, "insertTakeNudge input")?;
            s.insert_take_nudge(&n)
        })
    }
}
