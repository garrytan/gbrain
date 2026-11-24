//! The four fact reads and writes a `forget` (src/core/facts/forget.ts) and a proposal review
//! (src/core/facts/proposal-review.ts) make, from `engine-sql/facts-trust.ts`:
//!
//! - `readFactForForget(id)`: the columns a forget decides on, for one fact by id in any source, or `None`.
//! - `expireFactSuperseded(factId, validUntil)`: ends an active fact at `validUntil`, or when none is given at its own
//!   earlier end or now (never before the fact began), and expires it now. A fact that is gone or already expired is
//!   left alone.
//! - `expireFactAtDate(factId, today)`: ends an active fact on the date `today` (midnight UTC) and expires it now.
//! - `readWithdrawalAnchor(factId, sourceId)`: whether the withdrawal ledger covers the source's fact (a withdrawal of
//!   the same visibility under either of the fact's fingerprints that reaches the row), or `None` when the fact is not
//!   in that source.
//!
//! Both writes go through `write_fact`, as `expireFact` does, so the trust stamp and the purge refusal apply.
//! See rust/docs/store/facts.md, "Forget reads and expiry".

use super::generations::covers_fact;
use super::{read_fact, time_arg, write_fact};
use crate::Store;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::links::no_nul;
use crate::trust::fingerprint::{fact_fingerprint, fact_fingerprint_v1};
use serde::Deserialize;
use serde_json::{Value, json};

/// `readFactForForget(id)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForgetReadArgs {
    pub id: f64,
}

/// `expireFactSuperseded(factId, validUntil)`: `valid_until` is an ISO instant or absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpireSupersededArgs {
    pub fact_id: f64,
    #[serde(default)]
    pub valid_until: Option<String>,
}

/// `expireFactAtDate(factId, today)`: `today` is a `YYYY-MM-DD` date.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpireAtDateArgs {
    pub fact_id: f64,
    pub today: String,
}

/// `readWithdrawalAnchor(factId, sourceId)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawalAnchorArgs {
    pub fact_id: f64,
    pub source_id: String,
}

fn invalid(message: String) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, message)
}

/// A JavaScript number bound to the `bigint` id column: a whole number, or the error Postgres raises. A row id below 1
/// names no row.
pub(super) fn fact_number(op: &str, id: f64) -> Result<Option<u64>> {
    if !id.is_finite() || id.fract() != 0.0 || id.abs() > 9.223_372_036_854_775e18 {
        return Err(invalid(format!(
            "{op}: invalid input syntax for type bigint: \"{id}\" (id)"
        )));
    }
    Ok((id >= 1.0).then_some(id as u64))
}

impl Store {
    /// `expireFactSuperseded`: `valid_until = COALESCE(validUntil, GREATEST(valid_from, LEAST(COALESCE(valid_until,
    /// now), now)))`, `expired_at = now`, for an unexpired fact only.
    pub fn expire_fact_superseded(&self, args: &ExpireSupersededArgs) -> Result<()> {
        const OP: &str = "expireFactSuperseded";
        let id = fact_number(OP, args.fact_id)?;
        let until = args
            .valid_until
            .as_deref()
            .map(|t| time_arg(OP, "validUntil", t))
            .transpose()?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = id.map(|id| read_fact(tx, id)).transpose()?.flatten() else {
                return Ok(());
            };
            if old.expired_at_us.is_some() {
                return Ok(());
            }
            let mut new = old.clone();
            new.valid_until_us = Some(until.unwrap_or_else(|| {
                old.valid_from_us
                    .max(old.valid_until_us.unwrap_or(now).min(now))
            }));
            new.expired_at_us = Some(now);
            write_fact(tx, trust, Some(&old), &new)
        })
    }

    /// `expireFactAtDate`: `valid_until = today` (midnight UTC), `expired_at = now`, for an unexpired fact only.
    pub fn expire_fact_at_date(&self, args: &ExpireAtDateArgs) -> Result<()> {
        const OP: &str = "expireFactAtDate";
        let id = fact_number(OP, args.fact_id)?;
        let day = time_arg(OP, "today", &format!("{}T00:00:00Z", args.today))?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = id.map(|id| read_fact(tx, id)).transpose()?.flatten() else {
                return Ok(());
            };
            if old.expired_at_us.is_some() {
                return Ok(());
            }
            let mut new = old.clone();
            new.valid_until_us = Some(day);
            new.expired_at_us = Some(now);
            write_fact(tx, trust, Some(&old), &new)
        })
    }

    /// `readWithdrawalAnchor`: `{ withdrawn }` for a fact of `sourceId`, `None` for one that is gone or in another
    /// source. A ledger row counts when its visibility is the fact's, its hash is the fact's current or v1
    /// fingerprint, and `withdrawalCoversFactSql` reaches the row (`covers_fact`).
    pub fn read_withdrawal_anchor(&self, args: &WithdrawalAnchorArgs) -> Result<Option<Value>> {
        const OP: &str = "readWithdrawalAnchor";
        no_nul(OP, &[("sourceId", &args.source_id)])?;
        let Some(id) = fact_number(OP, args.fact_id)? else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(f) = read_fact(&*read, id)?.filter(|f| f.source_id == args.source_id) else {
            return Ok(None);
        };
        let hashes = [fact_fingerprint(&f.fact), fact_fingerprint_v1(&f.fact)];
        let mut withdrawn = false;
        for key in self.list_fact_withdrawal_keys(&f.source_id, i64::MAX)? {
            if key.visibility == f.visibility
                && hashes.contains(&key.fact_hash)
                && covers_fact(&*read, &f, &key.subject)?
            {
                withdrawn = true;
                break;
            }
        }
        Ok(Some(json!({ "withdrawn": withdrawn })))
    }
}
