//! Trust: the fact withdrawal ledger (`gbrain_store::trust::withdrawals`).
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
}
