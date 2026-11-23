//! The withdrawal check a prepared import runs on a malformed facts fence (src/core/engine-sql/withdrawal-fence.ts):
//! the one `hasWithdrawnFenceClaim` member `assertPreparedFactWithdrawals` (src/core/facts/withdrawal.ts) calls.
//!
//! The Postgres statement fingerprints each claim (`gbrain_fact_fingerprint` and `gbrain_fact_fingerprint_v1`) and
//! joins the union of `fact_withdrawals` and `fact_purges` of the source on: hash equal to either fingerprint, the
//! claim's visibility (any visibility when it has none), subject `*` or the given subject (any subject when none).
//! Both ledgers match both fingerprints here, unlike `isFactWithdrawn`, whose purge half reads the fingerprint only.
//! The store answers the same predicate from the withdrawal ledger (`t 0x01`, `trust::withdrawals`) and the purge
//! ledger (`F 0x0F`, `facts::purge_ledger`); it has no key range of its own.

use crate::Store;
use crate::error::Result;
use crate::facts::purge_ledger::purge_hash_under;
use crate::links::no_nul;
use crate::trust::fingerprint::{fact_fingerprint, fact_fingerprint_v1};
use crate::trust::withdrawals::withdrawal_hash_under;
use serde::Deserialize;

const OP: &str = "hasWithdrawnFenceClaim";

/// The two values of the ledgers' `visibility` CHECK.
const VISIBILITIES: [&str; 2] = ["private", "world"];

/// One claim of a malformed fence: its text and its visibility cell (`None` when the cell is not private or world).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FenceClaim {
    pub claim: String,
    #[serde(default)]
    pub visibility: Option<String>,
}

impl Store {
    /// `hasWithdrawnFenceClaim(sourceId, claims, subject)`: whether a withdrawal or a purge tombstone of the source
    /// has the fingerprint or v1 fingerprint of a claim, at its visibility (either when `None`), under subject `*`
    /// or `subject` (any subject when `None`). False for no claims.
    pub fn has_withdrawn_fence_claim(
        &self,
        source_id: &str,
        claims: &[FenceClaim],
        subject: Option<&str>,
    ) -> Result<bool> {
        no_nul(
            OP,
            &[("sourceId", source_id), ("subject", subject.unwrap_or(""))],
        )?;
        for c in claims {
            no_nul(
                OP,
                &[
                    ("claim", &c.claim),
                    ("visibility", c.visibility.as_deref().unwrap_or("")),
                ],
            )?;
        }
        if claims.is_empty() {
            return Ok(false);
        }
        let read = self.read()?;
        for c in claims {
            let hashes = [fact_fingerprint(&c.claim), fact_fingerprint_v1(&c.claim)];
            let visibilities: Vec<&str> = match c.visibility.as_deref() {
                Some(v) => vec![v],
                None => VISIBILITIES.to_vec(),
            };
            for visibility in visibilities {
                for hash in &hashes {
                    if withdrawal_hash_under(&*read, source_id, visibility, subject, hash)?
                        || purge_hash_under(&*read, source_id, visibility, subject, hash)?
                    {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }
}
