//! Takes and synthesis evidence.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. The shell normalizes weights and defaults first (as `buildTakeRows` does)
//! and makes the ISO timestamps `Date`-free strings, as PGLite's `takeRowToTake` does.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};
use gbrain_store::takes;

mod reads;

#[napi]
impl Brain {
    /// `addTakesBatch(rows)`: resolves the number of rows given.
    #[napi]
    pub fn add_takes_batch<'env>(&self, env: &'env Env, rows: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<takes::TakeInput> = required(rows, "addTakesBatch rows")?;
            s.add_takes_batch(&rows)
        })
    }

    /// `listTakes(opts)`: the resolved filter (see `ListTakesOptions`).
    #[napi]
    pub fn list_takes<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_takes(&arg(options, "listTakes options")?)
        })
    }

    /// `listActiveTakesForPages(pageIds, opts)`: active takes by `(page_id, row_num)`.
    #[napi]
    pub fn list_active_takes_for_pages<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: takes::ActiveTakesInput = required(input, "listActiveTakesForPages input")?;
            s.list_active_takes_for_pages(&input)
        })
    }

    /// `searchTakes(query, opts)`: trigram matches, best first.
    #[napi]
    pub fn search_takes<'env>(&self, env: &'env Env, options: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let options: takes::SearchTakesOptions = required(options, "searchTakes options")?;
            s.search_takes(&options)
        })
    }

    /// `updateTake(pageId, rowNum, fields)`: resolves whether the take exists.
    #[napi]
    pub fn update_take<'env>(&self, env: &'env Env, input: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: takes::UpdateTakeInput = required(input, "updateTake input")?;
            s.update_take(&input)
        })
    }

    /// `supersedeTake(pageId, oldRow, newRow)`: resolves `{ status, old_row?, new_row? }`.
    #[napi]
    pub fn supersede_take<'env>(&self, env: &'env Env, input: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: takes::SupersedeTakeInput = required(input, "supersedeTake input")?;
            s.supersede_take(&input)
        })
    }

    /// `resolveTake(pageId, rowNum, resolution)`: resolves `not_found`, `resolved` or `ok`.
    #[napi]
    pub fn resolve_take<'env>(&self, env: &'env Env, input: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: takes::ResolveTakeInput = required(input, "resolveTake input")?;
            s.resolve_take(&input)
        })
    }

    /// `getScorecard(opts, allowList)`: the raw counts `finalizeScorecard` reads.
    #[napi]
    pub fn get_scorecard<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_scorecard(&arg(options, "getScorecard options")?)
        })
    }

    /// `getCalibrationCurve(opts, allowList)`: buckets by `bucket_lo`.
    #[napi]
    pub fn get_calibration_curve<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_calibration_curve(&arg(options, "getCalibrationCurve options")?)
        })
    }

    /// `addSynthesisEvidence(rows)`: resolves the number of rows inserted.
    #[napi]
    pub fn add_synthesis_evidence<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<takes::EvidenceInput> = required(rows, "addSynthesisEvidence rows")?;
            s.add_synthesis_evidence(&rows)
        })
    }

    /// `matchTakeRows(pageId, rows, limit)`: resolves the row numbers of the page's takes that
    /// differ from the fence row of the same number, ascending.
    #[napi]
    pub fn match_take_rows<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        rows: Value,
        limit: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<takes::FenceRowInput> = required(rows, "matchTakeRows rows")?;
            s.match_take_rows(page_id as i64, &rows, &limit)
        })
    }

    /// `deleteTakeRows(pageId, rowNums)`: resolves null.
    #[napi]
    pub fn delete_take_rows<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row_nums: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row_nums: Vec<Value> = required(row_nums, "deleteTakeRows rowNums")?;
            s.delete_take_rows(page_id as i64, &row_nums)
        })
    }
}
