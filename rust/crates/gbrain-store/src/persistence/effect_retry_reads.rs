//! The reads of a parked-effect retry (`src/core/engine-sql/effect-retry.ts`; rust/docs/store/persistence.md,
//! "Effect retry reads"): one source's request by journal id or by client request id, the effects a retry tracks
//! and one effect row by id. Each returns rows as `SELECT *` returns them (`RequestRecord::to_row`,
//! `EffectRecord::to_row`). A request or row id that is not a UUID refuses, as the SQL's `::uuid` casts do.

use super::effects::{effect_by_id, request_effects};
use super::{RequestRecord, all_requests, request_by_id, uuid_param};
use crate::Store;
use crate::error::{Result, StoreError};
use serde_json::Value;

impl Store {
    /// `readSourceRequestById(sourceId, id)`: the request row `id` of `source_id`, or `None`.
    pub fn read_source_request_by_id(&self, source_id: &str, id: &str) -> Result<Option<Value>> {
        Ok(request_by_id(&*self.read()?, id)?
            .filter(|r| r.source_id == source_id)
            .map(|r| r.to_row()))
    }

    /// `listSourceRequestsByRequestId(sourceId, requestId)`: at most two request rows of
    /// `source_id` admitted under client request id `request_id` (any principal), by sequence; a
    /// second row means the id is ambiguous.
    pub fn list_source_requests_by_request_id(
        &self,
        source_id: &str,
        request_id: &str,
    ) -> Result<Vec<Value>> {
        let wanted = uuid_param(request_id, "requestId")?;
        let mut rows: Vec<RequestRecord> = all_requests(&*self.read()?)?
            .into_iter()
            .filter(|r| r.source_id == source_id && r.request_id.to_lowercase() == wanted)
            .collect();
        rows.sort_by_key(|r| r.sequence);
        Ok(rows.iter().take(2).map(RequestRecord::to_row).collect())
    }

    /// `listRetryTrackedEffects(requestRowId, parkedOnly, failedCodes)`: the effects of request row
    /// `request_row_id` that a retry tracks, by kind in byte order: a Git or withdrawal-mirror effect
    /// with parked or retried targets; unless `parked_only`, a failed effect (an embedding effect only
    /// when it failed `source_changed`) and an embedding effect with parked targets; and a failed Git
    /// effect whose code is one of `failed_codes`.
    pub fn list_retry_tracked_effects(
        &self,
        request_row_id: &str,
        parked_only: bool,
        failed_codes: &[String],
    ) -> Result<Vec<Value>> {
        let id = uuid_param(request_row_id, "requestId")?;
        let mut effects = request_effects(&*self.read()?, &id)?;
        effects.retain(|e| {
            let has = |key: &str| e.data.get(key).is_some();
            let failed = e.state == "failed";
            (matches!(e.kind.as_str(), "git" | "withdrawal-mirror")
                && (has("parked") || has("retried")))
                || (!parked_only
                    && ((failed
                        && (e.kind != "embedding"
                            || e.error_code.as_deref() == Some("source_changed")))
                        || (e.kind == "embedding" && has("parked"))))
                || (e.kind == "git"
                    && failed
                    && e.error_code
                        .as_ref()
                        .is_some_and(|c| failed_codes.contains(c)))
        });
        effects.sort_by(|a, b| a.kind.as_bytes().cmp(b.kind.as_bytes()));
        Ok(effects.iter().map(|e| e.to_row()).collect())
    }

    /// `lockEffectRow(id)`: effect `id` as `SELECT *` returns it, or `None`. The store runs one
    /// write at a time, so the row lock `FOR UPDATE` takes holds already.
    pub fn lock_effect_row(&self, id: &str) -> Result<Option<Value>> {
        let id: i64 = id
            .trim()
            .parse()
            .map_err(|_| StoreError::invalid(format!("effect id is not a bigint: {id:?}")))?;
        Ok(effect_by_id(&*self.read()?, id)?.map(|e| e.to_row()))
    }
}
