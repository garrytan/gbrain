//! The fact fingerprints, for a caller that compares facts without a store: the digest the
//! `gbrain_fact_fingerprint` SQL function gives a claim, and the one its first version gave.

use crate::facts::fact_fingerprint;
use crate::trust::fact_fingerprint_v1;
use serde::Serialize;

/// The two fingerprints of one claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FactFingerprints {
    /// `gbrain_fact_fingerprint(claim)`: the sha256 hex of the normalized claim.
    pub fingerprint: String,
    /// `gbrain_fact_fingerprint_v1(claim)`: the sha256 hex of
    /// `regexp_replace(lower(btrim(claim)), '[[:space:]]+', ' ', 'g')`.
    pub fingerprint_v1: String,
}

/// The fingerprints of each text, in order.
pub fn fact_fingerprints(texts: &[String]) -> Vec<FactFingerprints> {
    texts
        .iter()
        .map(|text| FactFingerprints {
            fingerprint: fact_fingerprint(text),
            fingerprint_v1: fact_fingerprint_v1(text),
        })
        .collect()
}
