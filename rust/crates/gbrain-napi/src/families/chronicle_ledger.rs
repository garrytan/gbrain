//! The chronicle ledger: the decision upsert, the judge slot, its pruning and the rollup members of
//! `engine-sql/collate-store-reads.ts` (rust/docs/store/chronicle-ledger.md).

use gbrain_store::chronicle_ledger::{ChronicleJudgeKey, ChronicleRowInput};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `upsertChronicleRow(w)`: resolves true when the row was written. The row's source and page must exist (the SQL
    /// foreign keys), else it refuses `source_not_found` or `page_not_found` and writes nothing.
    #[napi]
    pub fn upsert_chronicle_row<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ChronicleRowInput = required(row, "upsertChronicleRow row")?;
            s.upsert_chronicle_row(&row)
        })
    }

    /// `reserveChronicleJudgeSlot(limit, key)`: resolves true when a slot was taken.
    #[napi]
    pub fn reserve_chronicle_judge_slot<'env>(
        &self,
        env: &'env Env,
        limit: i64,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: ChronicleJudgeKey = required(key, "reserveChronicleJudgeSlot key")?;
            s.reserve_chronicle_judge_slot(limit, &key)
        })
    }

    /// `pruneChronicleReservations()`: resolves the number of reservations older than 48 hours it deleted.
    #[napi]
    pub fn prune_chronicle_reservations<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prune_chronicle_reservations())
    }

    /// `readChronicleLedger()`: `{ counts, reasons, calls, principals }` of the automatic rows.
    #[napi]
    pub fn read_chronicle_ledger<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_chronicle_ledger())
    }
}
