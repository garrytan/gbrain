//! Trust: the fact withdrawal ledger (`gbrain_store::trust::withdrawals`) and the write gate
//! (`gbrain_store::trust::write_gate`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `hasCoveringFactWithdrawal(sourceId, visibility, factHash, claim, subject)`: resolves a
    /// boolean.
    #[napi]
    pub fn has_covering_fact_withdrawal<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        visibility: String,
        fact_hash: String,
        claim: String,
        subject: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_covering_fact_withdrawal(&source_id, &visibility, &fact_hash, &claim, &subject)
        })
    }

    /// `isFactWithdrawn(sourceId, visibility | null, claim, entitySlug | null, memberPage |
    /// null)`: resolves a boolean.
    #[napi]
    pub fn is_fact_withdrawn<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        visibility: Option<String>,
        claim: String,
        entity_slug: Option<String>,
        member_page: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.is_fact_withdrawn(
                &source_id,
                visibility.as_deref(),
                &claim,
                entity_slug.as_deref(),
                member_page.as_deref(),
            )
        })
    }

    /// `isFactPurged(sourceId, visibility, claim, entitySlug | null)`: resolves a boolean.
    #[napi]
    pub fn is_fact_purged<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        visibility: String,
        claim: String,
        entity_slug: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.is_fact_purged(&source_id, &visibility, &claim, entity_slug.as_deref())
        })
    }

    /// `insertFactWithdrawal(sourceId, visibility, claim, subject, withdrawnAt | null)`: resolves
    /// true when it recorded the withdrawal, false when it was already recorded.
    #[napi]
    pub fn insert_fact_withdrawal<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        visibility: String,
        claim: String,
        subject: String,
        withdrawn_at: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_fact_withdrawal(
                &source_id,
                &visibility,
                &claim,
                &subject,
                withdrawn_at.as_deref(),
            )
        })
    }

    /// `listFactWithdrawalDates(sourceId, [{ row_num, claim, visibility }], subject | null)`:
    /// resolves `[{ row_num, withdrawn_at }]` by row number; `withdrawn_at` is ISO text.
    #[napi]
    pub fn list_fact_withdrawal_dates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        claims: Value,
        subject: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let claims: Vec<gbrain_store::trust::withdrawals::WithdrawalClaim> =
                required(claims, "listFactWithdrawalDates claims")?;
            s.list_fact_withdrawal_dates(&source_id, &claims, subject.as_deref())
        })
    }

    /// `moveFactWithdrawalSubject(sourceId, oldSlug, newSlug)`: resolves null.
    #[napi]
    pub fn move_fact_withdrawal_subject<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        old_slug: String,
        new_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.move_fact_withdrawal_subject(&source_id, &old_slug, &new_slug)
        })
    }

    /// `hasFactWithdrawalForSubject(sourceId, subject)`: resolves a boolean.
    #[napi]
    pub fn has_fact_withdrawal_for_subject<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        subject: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_fact_withdrawal_for_subject(&source_id, &subject)
        })
    }

    /// `readSourcePurgeFlags(sourceId)`: resolves `{ facts, takes }`.
    #[napi]
    pub fn read_source_purge_flags<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_source_purge_flags(&source_id)
                .map(|(facts, takes)| serde_json::json!({ "facts": facts, "takes": takes }))
        })
    }

    /// `listPurgedTakeRows(sourceId, [{ row_num, claim }], subject | null)`: resolves the matched
    /// row numbers, ascending.
    #[napi]
    pub fn list_purged_take_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        takes: Value,
        subject: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let takes: Vec<gbrain_store::facts::take_purges::TakeClaimRow> =
                required(takes, "listPurgedTakeRows takes")?;
            s.list_purged_take_rows(&source_id, &takes, subject.as_deref())
        })
    }

    /// `listFactWithdrawalKeys(sourceId, limit)`: resolves `[{ visibility, fact_hash, subject }]`.
    #[napi]
    pub fn list_fact_withdrawal_keys<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_fact_withdrawal_keys(&source_id, limit))
    }

    /// `readFactCacheWatermark(sourceId)`: resolves `{ withdrawals, latest_withdrawn_at,
    /// access_rules }`.
    #[napi]
    pub fn read_fact_cache_watermark<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_fact_cache_watermark(&source_id))
    }

    /// `readTrustGeneration()`: resolves the trust policy generation as decimal text (the
    /// store's commit sequence).
    #[napi]
    pub fn read_trust_generation<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_trust_generation())
    }

    /// `upsertWriteGateReceipt(input)`: resolves the receipt id.
    #[napi]
    pub fn upsert_write_gate_receipt<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::trust::write_gate::ReceiptInput =
                required(input, "upsertWriteGateReceipt input")?;
            s.upsert_write_gate_receipt(input)
        })
    }

    /// `upsertPageWriteGateReceipt(sourceId, slug, receipt)`: resolves the receipt id, or null
    /// when no live page has the slug.
    #[napi]
    pub fn upsert_page_write_gate_receipt<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        receipt: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let receipt: gbrain_store::trust::write_gate::ReceiptFields =
                required(receipt, "upsertPageWriteGateReceipt receipt")?;
            s.upsert_page_write_gate_receipt(&source_id, &slug, receipt)
        })
    }

    /// `deleteStalePageWriteGateReceipts(sourceId, slug, contentHash | null)`: resolves null.
    #[napi]
    pub fn delete_stale_page_write_gate_receipts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        content_hash: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_stale_page_write_gate_receipts(&source_id, &slug, content_hash.as_deref())
        })
    }

    /// `listWriteGateReceiptsFor(targetTable, targetId, limit)`: resolves the receipt rows; the
    /// times are ISO text.
    #[napi]
    pub fn list_write_gate_receipts_for<'env>(
        &self,
        env: &'env Env,
        target_table: String,
        target_id: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_write_gate_receipts_for(&target_table, &target_id, limit)
        })
    }

    /// `deleteStaleWriteGateReceipts(olderThanDays)`: resolves how many receipts it deleted.
    #[napi]
    pub fn delete_stale_write_gate_receipts<'env>(
        &self,
        env: &'env Env,
        older_than_days: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_stale_write_gate_receipts(older_than_days)
        })
    }

    /// `upsertWriteGateHold(input)`: resolves the hold id.
    #[napi]
    pub fn upsert_write_gate_hold<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::trust::write_gate::HoldInput =
                required(input, "upsertWriteGateHold input")?;
            s.upsert_write_gate_hold(input)
        })
    }

    /// `listWriteGateHoldRows(opts)`: resolves the hold rows, highest id first; the times are ISO
    /// text.
    #[napi]
    pub fn list_write_gate_hold_rows<'env>(
        &self,
        env: &'env Env,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: gbrain_store::trust::write_gate::HoldListOpts =
                required(opts, "listWriteGateHoldRows opts")?;
            s.list_write_gate_hold_rows(&opts)
        })
    }

    /// `getWriteGateHoldRow(id)`: resolves the hold row or null.
    #[napi]
    pub fn get_write_gate_hold_row<'env>(
        &self,
        env: &'env Env,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_write_gate_hold_row(id))
    }

    /// `decideWriteGateHold(id, status, decidedBy)`: resolves true when it decided a held row.
    #[napi]
    pub fn decide_write_gate_hold<'env>(
        &self,
        env: &'env Env,
        id: i64,
        status: String,
        decided_by: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.decide_write_gate_hold(id, &status, &decided_by)
        })
    }
}
