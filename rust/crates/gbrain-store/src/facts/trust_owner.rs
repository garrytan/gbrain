//! Group 5 facts reads over the stamped trust columns and the write-gate receipts that serve the
//! owner (src/core/engine-sql/facts-trust.ts): `readFactForOwnerAction` (the row `gbrain trust
//! confirm` binds its preview to), `countDerivedFactTaint` (the doctor taint share) and `listStandingPreferences` (the
//! `gbrain trust review` list). `listLexicalContestCandidates` is `facts/contest.rs`.
//!
//! The TypeScript member (src/core/rust-engine/store-members/facts-trust-owner.ts) refuses an id
//! that is not an integer, turns the times into `Date`, and passes the claim rule's owner floor and
//! connector kinds (src/core/trust/claim-state.ts) so the store keeps no second copy of them.

use super::trust_reads::all_fact_rows;
use super::{FactRecord, opt_time, read_fact, source_rows};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use crate::trust::TrustTier;
use crate::trust::write_gate::flagged_for;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

/// `readFactForOwnerAction(id)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerActionFactQuery {
    pub id: i64,
}

/// `listStandingPreferences({ sourceId, since })` with the claim rule the member passes:
/// `ownerFloor` (`OWNER_TIER_FLOOR`) and `connectorKinds` (`CONNECTOR_SOURCE_KINDS`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StandingPreferencesQuery {
    pub source_id: Option<String>,
    pub since: Option<String>,
    pub owner_floor: String,
    pub connector_kinds: Vec<String>,
}

/// The tiers `listStandingPreferences` lists: `trust_tier IN ('agent_written', 'unknown', 'external_untrusted')`.
const UNCONFIRMED_TIERS: [TrustTier; 3] = [
    TrustTier::AgentWritten,
    TrustTier::Unknown,
    TrustTier::ExternalUntrusted,
];

/// `write_origin ? 'taint_inputs'`: an object with the key (any value, JSON null included), an
/// array with the string element, or the string scalar itself.
fn names_taint_inputs(origin: Option<&Value>) -> bool {
    const KEY: &str = "taint_inputs";
    match origin {
        Some(Value::Object(map)) => map.contains_key(KEY),
        Some(Value::Array(items)) => items.iter().any(|v| v.as_str() == Some(KEY)),
        Some(Value::String(s)) => s == KEY,
        _ => false,
    }
}

/// `claimPendingSql('cs')` over a source's config: `config ? 'trust_claimed_at'`,
/// `config->>'trust_tier' = ownerFloor`, `COALESCE(config->>'kind', '')` not a connector kind, and
/// no `trust_claim_lifted_at` key. A source that does not exist is not pending (no `EXISTS` row).
fn claim_pending(read: &dyn KvRead, source_id: &str, q: &StandingPreferencesQuery) -> Result<bool> {
    let Some(source) = read_source(read, source_id)? else {
        return Ok(false);
    };
    let config = &source.config;
    let text = |key: &str| config.get(key).and_then(jsonb_field_text);
    let kind = text("kind").unwrap_or_default();
    Ok(config.contains_key("trust_claimed_at")
        && text("trust_tier").as_deref() == Some(q.owner_floor.as_str())
        && !q.connector_kinds.contains(&kind)
        && !config.contains_key("trust_claim_lifted_at"))
}

impl Store {
    /// `readFactForOwnerAction`: the 16 columns the owner binding hashes, in the SELECT's order,
    /// or `null` when no fact has the id. The member turns `expired_at` into a `Date`.
    pub fn read_fact_for_owner_action(&self, q: &OwnerActionFactQuery) -> Result<Value> {
        let read = self.read()?;
        let Some(f) = u64::try_from(q.id)
            .ok()
            .map(|id| read_fact(&*read, id))
            .transpose()?
            .flatten()
        else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "id": f.id,
            "source_id": f.source_id,
            "trust_tier": f.tier().as_str(),
            "fact": f.fact,
            "entity_slug": f.entity_slug,
            "kind": f.kind,
            "claim_metric": f.claim_metric,
            "claim_value": f.claim_value,
            "claim_unit": f.claim_unit,
            "claim_period": f.claim_period,
            "value": f.value,
            "event_type": f.event_type,
            "dimension": f.dimension,
            "context": f.context,
            "expired_at": f.expired_at_us.map(iso),
            "superseded_by": f.superseded_by,
        }))
    }

    /// `countDerivedFactTaint`: over every fact of every source, how many have a write origin that
    /// names `taint_inputs`, and how many of those are stamped `external_untrusted`.
    pub fn count_derived_fact_taint(&self) -> Result<Value> {
        let read = self.read()?;
        let (mut derived, mut external) = (0u64, 0u64);
        for f in all_fact_rows(&*read)? {
            if names_taint_inputs(f.write_origin.as_ref()) {
                derived += 1;
                if f.tier() == TrustTier::ExternalUntrusted {
                    external += 1;
                }
            }
        }
        Ok(json!({ "derived": derived, "external": external }))
    }

    /// `listStandingPreferences`: the unexpired `preference` and `commitment` facts at an
    /// unconfirmed tier that hold a `flag` receipt in the `standing_instruction` family, less the
    /// `unknown` ones of a source whose claim is still being lifted; of `sourceId` and created at
    /// or after `since` when given. By `created_at`, then id, at most 1000. The member turns
    /// `created_at` into a `Date`.
    pub fn list_standing_preferences(&self, q: &StandingPreferencesQuery) -> Result<Vec<Value>> {
        let op = "listStandingPreferences";
        let mut checked = vec![("ownerFloor", q.owner_floor.as_str())];
        if let Some(source) = q.source_id.as_deref() {
            checked.push(("sourceId", source));
        }
        no_nul(op, &checked)?;
        let since = opt_time(op, "since", &q.since)?;
        let read = self.read()?;
        let rows = match q.source_id.as_deref() {
            Some(source) => source_rows(&*read, source)?,
            None => all_fact_rows(&*read)?,
        };
        let mut pending: HashMap<String, bool> = HashMap::new();
        let mut out: Vec<FactRecord> = Vec::new();
        for f in rows {
            if !matches!(f.kind.as_str(), "preference" | "commitment")
                || !UNCONFIRMED_TIERS.contains(&f.tier())
                || f.expired_at_us.is_some()
                || since.is_some_and(|s| f.created_at_us < s)
            {
                continue;
            }
            if f.tier() == TrustTier::Unknown {
                let claimed = match pending.get(&f.source_id) {
                    Some(&p) => p,
                    None => {
                        let p = claim_pending(&*read, &f.source_id, q)?;
                        pending.insert(f.source_id.clone(), p);
                        p
                    }
                };
                if claimed {
                    continue;
                }
            }
            if flagged_for(&*read, "facts", f.id, "standing_instruction")? {
                out.push(f);
            }
        }
        out.sort_by_key(|f| (f.created_at_us, f.id));
        Ok(out
            .into_iter()
            .take(1000)
            .map(|f| {
                json!({
                    "id": f.id,
                    "source_id": f.source_id,
                    "kind": f.kind,
                    "fact": f.fact,
                    "trust_tier": f.tier().as_str(),
                    "slug": f.source_markdown_slug,
                    "created_at": iso(f.created_at_us),
                })
            })
            .collect())
    }
}
