//! The reads `remember` and `forget` make before admission (src/core/engine-sql/memory-mutation-reads.ts):
//! `readSourceWriteRow`, `readSourceLocalPath`, `readFactEntitySlug`, `hasLiveFileBackedPage`,
//! `factReadableUnder` and `readRemoteForgetTier`. Each answers from the source, fact and page records the other families write.
//!
//! The TypeScript member (src/core/rust-engine/store-members/memory-mutation-reads.ts) refuses what the store does not
//! model: a fact id that is not an integer, and a `factReadableUnder` read whose visibility rule a member page or a
//! private-facts grant widens for the caller, and a `readRemoteForgetTier` read whose remote provenance floor is not
//! the no-caller one.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::facts::PrivacyPolicy;
use crate::facts::{
    hidden_by_deleted_page, hidden_by_policy, hidden_by_provenance_page, hidden_by_quarantine,
    read_fact,
};
use crate::links::no_nul;
use crate::owner_only::{OwnerOnlyForm, fact_owner_only};
use crate::pages::read_page;
use crate::sources::read_source;
use crate::trust::TrustPolicy;
use serde::Deserialize;
use serde_json::{Value, json};

/// `factReadableUnder(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactReadableQuery {
    pub id: i64,
    pub source_id: String,
    /// The brain owner reads a fact of any visibility; anyone else only a `world` one.
    pub any_visibility: bool,
    /// `eligibility.floor`: `trustFloorSql` over the fact's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: drop a fact `activationSuppressedSql('facts')` flags.
    pub suppress_flagged: bool,
    /// `excludePrivate`: the private-provenance policy (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `readRemoteForgetTier(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteForgetTierQuery {
    pub fact_id: i64,
    pub source_id: String,
    /// `remoteFloor`: the remote provenance floor, as the no-caller rendering with this
    /// `honorAliases` setting; `None` reads without it.
    pub remote_floor: Option<RemoteFloor>,
}

/// The settings the remote provenance floor renders with, for a caller that is not labelled-only.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteFloor {
    /// `visibility.honor_aliases`.
    pub honor_aliases: bool,
    /// The caller record's `restricted` flag: whether the brain holds member-access restrictions.
    pub restricted: bool,
    /// The form of the floor's owner-only test: `off` for the owner, else `closed` or `fn` by the
    /// caller's schema version (`ownerOnlyFactAllowedSql`).
    pub owner_only: OwnerOnlyForm,
}

impl Store {
    /// `readSourceWriteRow`: the source's incarnation, archived flag, checkout and the `kind` and `role` config keys
    /// as `config->>key` text; `None` for an unknown id.
    pub fn read_source_write_row(&self, source_id: &str) -> Result<Option<Value>> {
        no_nul("readSourceWriteRow", &[("sourceId", source_id)])?;
        let read = self.read()?;
        Ok(read_source(&*read, source_id)?.map(|s| {
            json!({
                "incarnation": s.incarnation,
                "archived": s.archived,
                "local_path": s.local_path,
                "kind": fm_text(&s.config, "kind"),
                "role": fm_text(&s.config, "role"),
            })
        }))
    }

    /// `readSourceLocalPath`: the source's checkout; `None` for an unknown id or a source with none.
    pub fn read_source_local_path(&self, source_id: &str) -> Result<Option<String>> {
        no_nul("readSourceLocalPath", &[("sourceId", source_id)])?;
        let read = self.read()?;
        Ok(read_source(&*read, source_id)?.and_then(|s| s.local_path))
    }

    /// `readFactEntitySlug`: the entity of fact `id` when it belongs to `source_id`.
    pub fn read_fact_entity_slug(&self, id: i64, source_id: &str) -> Result<Option<String>> {
        no_nul("readFactEntitySlug", &[("sourceId", source_id)])?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(read_fact(&*read, id)?
            .filter(|row| row.source_id == source_id)
            .and_then(|row| row.entity_slug))
    }

    /// `hasLiveFileBackedPage`: whether a live page of `source_id` among `slugs` has a `source_path`.
    pub fn has_live_file_backed_page(&self, source_id: &str, slugs: &[String]) -> Result<bool> {
        const OP: &str = "hasLiveFileBackedPage";
        no_nul(OP, &[("sourceId", source_id)])?;
        for slug in slugs {
            no_nul(OP, &[("slug", slug)])?;
        }
        let read = self.read()?;
        for slug in slugs {
            if read_page(&*read, source_id, slug)?
                .is_some_and(|p| p.deleted_at_us.is_none() && p.source_path.is_some())
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `factReadableUnder`: whether fact `id` of `source_id` passes the caller's visibility rule,
    /// `projectionEligibleSql('facts')` (deleted and quarantined provenance pages, the trust floor and flag
    /// suppression; the store keeps no `needs_rederive` queue, so that clause hides nothing) and, with
    /// `excludePrivate`, the private-provenance policy.
    pub fn fact_readable_under(&self, q: &FactReadableQuery) -> Result<bool> {
        no_nul("factReadableUnder", &[("sourceId", &q.source_id)])?;
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), q.suppress_flagged)?;
        let Ok(id) = u64::try_from(q.id) else {
            return Ok(false);
        };
        let read = self.read()?;
        let Some(row) = read_fact(&*read, id)? else {
            return Ok(false);
        };
        Ok(row.source_id == q.source_id
            && (q.any_visibility || row.visibility == "world")
            && !hidden_by_deleted_page(&*read, &row)?
            && !hidden_by_quarantine(&*read, &row)?
            && trust.admits(&*read, "facts", row.id, row.tier())?
            && !hidden_by_policy(&*read, &row, &q.exclude_private)?)
    }

    /// `readRemoteForgetTier`: the stored tier of fact `fact_id` when it belongs to `source_id` and
    /// is a `world` fact, and with `remote_floor` its provenance page passes the page policy for
    /// the empty identity and the fact passes the floor's owner-only test
    /// (`privateProvenanceFilterFragment`; the store keeps no folder rule, so that conjunct hides
    /// nothing). `None` otherwise.
    pub fn read_remote_forget_tier(&self, q: &RemoteForgetTierQuery) -> Result<Option<String>> {
        no_nul("readRemoteForgetTier", &[("sourceId", &q.source_id)])?;
        let Ok(id) = u64::try_from(q.fact_id) else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(row) = read_fact(&*read, id)? else {
            return Ok(None);
        };
        if row.source_id != q.source_id || row.visibility != "world" {
            return Ok(None);
        }
        if let Some(floor) = &q.remote_floor {
            let policy = PrivacyPolicy {
                honor_aliases: floor.honor_aliases,
                ..PrivacyPolicy::default()
            };
            if hidden_by_provenance_page(&*read, &row, &policy, floor.restricted)?
                || fact_owner_only(&*read, &row.source_id, floor.owner_only)?
            {
                return Ok(None);
            }
        }
        Ok(Some(row.tier().as_str().to_owned()))
    }
}
