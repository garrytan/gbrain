//! `normalizeDerivationClaims(claims)`: the claims in the form the derivation predicates match them (page-body
//! `derivationNeedles`, SQL in `engine-sql/collate-store-reads.ts`; rust/docs/store/facts.md).
//!
//! Each claim goes through `gbrain_fact_normalize` (`facts::fact_normalize`), then the fold of `page-body/schema.ts`
//! `foldSql`: final sigma to sigma, and the combining dot above (`U+0307`) after an `i` dropped. The empty results are
//! dropped, the rest de-duplicated and returned by byte.

use crate::error::{Result, StoreError};
use crate::facts::fact_normalize;
use std::collections::BTreeSet;

/// `translate(x, 'ς', 'σ')` then `replace(.., 'i' || U+0307, 'i')`.
fn fold(normalized: &str) -> String {
    normalized.replace('ς', "σ").replace("i\u{307}", "i")
}

impl crate::Store {
    /// The distinct, non-empty folded normalized claims, in byte order.
    pub fn normalize_derivation_claims(&self, claims: &[String]) -> Result<Vec<String>> {
        if claims.iter().any(|c| c.contains('\0')) {
            return Err(StoreError::invalid(
                "normalizeDerivationClaims: a claim contains a NUL character",
            ));
        }
        let folded: BTreeSet<String> = claims
            .iter()
            .map(|c| fold(&fact_normalize(c)))
            .filter(|f| !f.is_empty())
            .collect();
        Ok(folded.into_iter().collect())
    }
}
