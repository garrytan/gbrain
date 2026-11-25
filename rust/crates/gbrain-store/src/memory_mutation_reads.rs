//! The reads `remember` and `forget` make before admission (src/core/engine-sql/memory-mutation-reads.ts):
//! `readSourceWriteRow`, `readSourceLocalPath`, `readFactEntitySlug`, `hasLiveFileBackedPage`,
//! `factReadableUnder`, `readRemoteForgetTier` and `readForgetTarget`, and the reads a forget makes to decide what its
//! withdrawal reaches (src/core/persistence/forget-prepare.ts): `isFactEntityUnbacked`, `readLinkedFactCopies`,
//! `hasHiddenFactCopy` and `ownerReachesFact`. Each answers from the source, fact and page records the other families write.
//!
//! The TypeScript member (src/core/rust-engine/store-members/memory-mutation-reads.ts) refuses what the store does not
//! model: a fact id that is not an integer, and a `factReadableUnder` read whose visibility rule a member page or a
//! private-facts grant widens for the caller, and a `readRemoteForgetTier` read whose remote provenance floor is not
//! the no-caller one or a caller record's restricted, unrestricted or owner one (the same refusal covers
//! `readForgetTarget`, `readLinkedFactCopies` and `hasHiddenFactCopy` under their floor), and `ownerReachesFact` for an
//! owner bound to a member, whose pages the owner read rule (GST-2490 lineage) judges.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::env::iso;
use crate::error::Result;
use crate::facts::purge::{outcome_marker, unbacked};
use crate::facts::{
    FactRecord, access_id, access_readers, fact_fingerprint, hidden_by_deleted_page,
    hidden_by_policy, hidden_by_provenance_page, hidden_by_quarantine, read_fact, source_rows,
};
use crate::facts::{PrivacyPolicy, owner_reads_page};
use crate::kv::KvRead;
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
    /// The owner-only test the floor ends with (`ownerOnlyFactAllowedSql` on the fact, and the page
    /// owner-only test on its provenance page), in the form the member read off the text. Absent
    /// takes `closed`, which hides the most.
    #[serde(default)]
    pub owner_only: OwnerOnlyForm,
}

/// `readForgetTarget(spec)`; `lock` (FOR UPDATE) is dropped by the TypeScript member: one store
/// call reads under the store's own lock.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgetTargetQuery {
    pub id: i64,
    pub source_id: String,
    /// `worldOnly`: only a `world` fact (a remote caller that is not the owner).
    pub world_only: bool,
    /// `remoteFloor`: the remote provenance floor, as [`RemoteForgetTierQuery::remote_floor`].
    pub remote_floor: Option<RemoteFloor>,
    /// `ownPage`: a member's withdrawal on its own member page.
    pub own_page: Option<OwnPage>,
}

/// A member's own member page and the principal (`member:<id>`) its readers must name.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnPage {
    pub slug: String,
    pub reader: String,
}

/// `readLinkedFactCopies(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedCopiesQuery {
    pub id: i64,
    pub source_id: String,
    /// `worldOnly`: only `world` copies.
    pub world_only: bool,
    /// `remoteFloor`: only copies whose provenance page passes the floor.
    pub remote_floor: Option<RemoteFloor>,
}

/// `hasHiddenFactCopy(spec)`: the floor always applies.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HiddenCopyQuery {
    pub id: i64,
    pub source_id: String,
    pub remote_floor: RemoteFloor,
}

/// `ownerReachesFact(spec)`. With no `policy` the owner is bound to no member, so its read rule reads no page. With one
/// the owner is bound to the member the policy's `identity` names, and the policy's `identity` and `satisfied_rule_ids`
/// are the spec's `identity` and `satisfied` (the TypeScript member refuses a rendering the policy cannot carry).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerReachQuery {
    pub id: i64,
    pub source_id: String,
    #[serde(default)]
    pub policy: Option<PrivacyPolicy>,
}

/// `readFactWithdrawalClaim`'s spec: the fact a withdrawal admits.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawalClaimQuery {
    pub id: i64,
    pub source_id: String,
    /// `worldOnly`: only a `world` fact, or a `private` one on `member_page`.
    pub world_only: bool,
    /// `memberPage`: a member's own page (the caller checked it), whose private facts `world_only` admits.
    pub member_page: Option<String>,
    /// `remoteFloor`: the remote provenance floor, as [`RemoteForgetTierQuery::remote_floor`].
    pub remote_floor: Option<RemoteFloor>,
}

/// Whether `floor` hides `row` (`privateProvenanceFilterFragment`): its provenance page fails the
/// page policy for the empty identity, or the fact is owner-only in the floor's form.
pub(crate) fn floor_hides(
    read: &dyn KvRead,
    row: &FactRecord,
    floor: &RemoteFloor,
) -> Result<bool> {
    if fact_owner_only(read, row.id, &row.source_id, floor.owner_only)? {
        return Ok(true);
    }
    let policy = PrivacyPolicy {
        honor_aliases: floor.honor_aliases,
        provenance_only: true,
        owner_only: floor.owner_only,
        ..PrivacyPolicy::default()
    };
    hidden_by_provenance_page(read, row, &policy, floor.restricted)
}

/// Fact `id` when it belongs to `source_id`.
pub(crate) fn source_fact(
    read: &dyn KvRead,
    id: i64,
    source_id: &str,
) -> Result<Option<FactRecord>> {
    let Ok(id) = u64::try_from(id) else {
        return Ok(None);
    };
    Ok(read_fact(read, id)?.filter(|row| row.source_id == source_id))
}

/// The other active facts of `u`'s source and visibility whose claim has `u`'s fingerprint, by id.
fn active_copies(read: &dyn KvRead, u: &FactRecord, now: i64) -> Result<Vec<FactRecord>> {
    let print = fact_fingerprint(&u.fact);
    let mut out: Vec<FactRecord> = source_rows(read, &u.source_id)?
        .into_iter()
        .filter(|l| {
            l.id != u.id
                && l.visibility == u.visibility
                && l.active(now)
                && fact_fingerprint(&l.fact) == print
        })
        .collect();
    out.sort_by_key(|l| l.id);
    Ok(out)
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
    /// `projectionEligibleSql('facts')` (deleted and quarantined provenance pages, a row marked in
    /// `needs_rederive`, the trust floor and flag suppression) and, with
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
            && !crate::facts::hidden_by_rederive(&*read, &row)?
            && trust.admits(&*read, "facts", row.id, row.tier())?
            && !hidden_by_policy(&*read, &row, &q.exclude_private)?)
    }

    /// `readRemoteForgetTier`: the stored tier of fact `fact_id` when it belongs to `source_id` and
    /// is a `world` fact, and with `remote_floor` the floor does not hide it ([`floor_hides`]: its
    /// provenance page passes the page policy for the empty identity and the fact is not owner-only;
    /// the store keeps no folder rule, so that conjunct hides nothing). `None` otherwise.
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
        if let Some(floor) = &q.remote_floor
            && floor_hides(&*read, &row, floor)?
        {
            return Ok(None);
        }
        Ok(Some(row.tier().as_str().to_owned()))
    }

    /// `readForgetTarget`: fact `id` of `source_id` as a forget reads it (id, entity_slug,
    /// source_markdown_slug, row_num, expired_at, trust_tier), or `None` when the caller does not
    /// see it. With `own_page`: a `private` fact whose `source_markdown_slug` is that page while the
    /// live page's readers (`page_readers`, [`access_readers`]) name the member. Otherwise a fact of
    /// any visibility, only a `world` one with `world_only`, and with `remote_floor` one whose
    /// provenance page passes the floor as [`Store::read_remote_forget_tier`] judges it.
    pub fn read_forget_target(&self, q: &ForgetTargetQuery) -> Result<Option<Value>> {
        const OP: &str = "readForgetTarget";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        if let Some(own) = &q.own_page {
            no_nul(OP, &[("ownPage", &own.slug), ("reader", &own.reader)])?;
        }
        let Ok(id) = u64::try_from(q.id) else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(row) = read_fact(&*read, id)? else {
            return Ok(None);
        };
        if row.source_id != q.source_id {
            return Ok(None);
        }
        let seen = match &q.own_page {
            Some(own) => {
                row.visibility == "private"
                    && row.source_markdown_slug.as_deref() == Some(own.slug.as_str())
                    && read_page(&*read, &q.source_id, &own.slug)?.is_some_and(|p| {
                        p.deleted_at_us.is_none()
                            && access_readers(&p.frontmatter)
                                .is_some_and(|readers| readers.contains(&own.reader))
                    })
            }
            None => {
                (!q.world_only || row.visibility == "world")
                    && match &q.remote_floor {
                        Some(floor) => !floor_hides(&*read, &row, floor)?,
                        None => true,
                    }
            }
        };
        Ok(seen.then(|| {
            json!({
                "id": row.id,
                "entity_slug": row.entity_slug,
                "source_markdown_slug": row.source_markdown_slug,
                "row_num": row.row_num,
                "expired_at": row.expired_at_us.map(iso),
                "trust_tier": row.tier().as_str(),
            })
        }))
    }

    /// `isFactEntityUnbacked`: whether fact `id` of `source_id` names an entity with no `/` and no
    /// live page of that slug in the source (`unbackedEntitySql`); false for an unknown fact.
    pub fn is_fact_entity_unbacked(&self, id: i64, source_id: &str) -> Result<bool> {
        no_nul("isFactEntityUnbacked", &[("sourceId", source_id)])?;
        let read = self.read()?;
        match source_fact(&*read, id, source_id)? {
            Some(row) => unbacked(&*read, &row),
            None => Ok(false),
        }
    }

    /// `readLinkedFactCopies`: the other active facts of fact `id`'s source and visibility whose
    /// claim has its fingerprint and that name another, non-null entity, by id, at most five; only
    /// `world` ones with `world_only`, and with `remote_floor` only ones the floor does not hide.
    pub fn read_linked_fact_copies(&self, q: &LinkedCopiesQuery) -> Result<Vec<Value>> {
        no_nul("readLinkedFactCopies", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let Some(u) = source_fact(&*read, q.id, &q.source_id)? else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for l in active_copies(&*read, &u, self.env.now_micros())? {
            let Some(entity) = l.entity_slug.as_deref() else {
                continue;
            };
            if u.entity_slug.as_deref() == Some(entity) || (q.world_only && l.visibility != "world")
            {
                continue;
            }
            if let Some(floor) = &q.remote_floor
                && floor_hides(&*read, &l, floor)?
            {
                continue;
            }
            out.push(json!({ "id": l.id, "entity_slug": entity }));
            if out.len() == 5 {
                break;
            }
        }
        Ok(out)
    }

    /// `hasHiddenFactCopy`: whether an active copy of fact `id`'s claim (same source, visibility
    /// and fingerprint; any entity when the fact names none or an unbacked one, else the same
    /// entity) is one the remote provenance floor hides.
    pub fn has_hidden_fact_copy(&self, q: &HiddenCopyQuery) -> Result<bool> {
        no_nul("hasHiddenFactCopy", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let Some(u) = source_fact(&*read, q.id, &q.source_id)? else {
            return Ok(false);
        };
        let any_entity = u.entity_slug.is_none() || unbacked(&*read, &u)?;
        for l in active_copies(&*read, &u, self.env.now_micros())? {
            let reached = any_entity || (l.entity_slug.is_some() && l.entity_slug == u.entity_slug);
            if reached && floor_hides(&*read, &l, &q.remote_floor)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `ownerReachesFact`: fact `id` of `source_id` sits on no owned memory page and every page record (a deleted one
    /// too) at its `source_markdown_slug` and `entity_slug` passes the owner's read rule. An owner bound to no member
    /// (no `policy`, or a policy whose identity names no valid first `member:` principal, as `lineageReadPage` reads
    /// it) has a read rule of `FALSE`, so any page record at either slug fails it. An owner bound to a member
    /// ([`owner_reads_page`]) reaches a page it reads under GST-2490's owner read rule and the member read rule.
    pub fn owner_reaches_fact(&self, q: &OwnerReachQuery) -> Result<bool> {
        no_nul("ownerReachesFact", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let Some(row) = source_fact(&*read, q.id, &q.source_id)? else {
            return Ok(false);
        };
        if row.on_owned_memory_page() {
            return Ok(false);
        }
        let policy = q.policy.as_ref().filter(|p| owner_member(&p.identity));
        for slug in [
            row.source_markdown_slug.as_deref(),
            row.entity_slug.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let Some(page) = read_page(&*read, &q.source_id, slug)? else {
                continue;
            };
            match policy {
                Some(policy) if owner_reads_page(&*read, &page, policy)? => {}
                _ => return Ok(false),
            }
        }
        Ok(true)
    }

    /// `readFactWithdrawalClaim`: fact `id` of `source_id`'s visibility, text, fingerprint,
    /// ledger subject (`factWithdrawalSubjectSql`: its owned memory page's slug, `*` for no or an
    /// unbacked entity, else the entity) and whether it expired; none for an extraction outcome
    /// marker, for a fact `world_only` refuses (neither `world` nor `private` on `member_page`),
    /// or with `remote_floor` for one the floor hides.
    pub fn read_fact_withdrawal_claim(&self, q: &WithdrawalClaimQuery) -> Result<Option<Value>> {
        const OP: &str = "readFactWithdrawalClaim";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        if let Some(page) = &q.member_page {
            no_nul(OP, &[("memberPage", page)])?;
        }
        let read = self.read()?;
        let Some(row) = source_fact(&*read, q.id, &q.source_id)? else {
            return Ok(None);
        };
        let admitted = !q.world_only
            || row.visibility == "world"
            || (row.visibility == "private"
                && q.member_page.is_some()
                && row.source_markdown_slug == q.member_page);
        if outcome_marker(&row) || !admitted {
            return Ok(None);
        }
        if let Some(floor) = &q.remote_floor
            && floor_hides(&*read, &row, floor)?
        {
            return Ok(None);
        }
        let subject = if row.on_owned_memory_page() {
            row.source_markdown_slug.clone().unwrap_or_default()
        } else if unbacked(&*read, &row)? {
            "*".to_string()
        } else {
            row.entity_slug.clone().unwrap_or_else(|| "*".to_string())
        };
        Ok(Some(json!({
            "visibility": row.visibility,
            "fact": row.fact,
            "fact_hash": fact_fingerprint(&row.fact),
            "subject": subject,
            "expired": row.expired_at_us.is_some(),
        })))
    }
}

/// `lineageReadPage`: the first `member:` principal of the identity names the owner's member, and its id passes
/// `ACCESS_ID_RE`; any other identity leaves the owner read rule `FALSE`.
fn owner_member(identity: &[String]) -> bool {
    identity
        .iter()
        .find_map(|p| p.strip_prefix("member:"))
        .is_some_and(access_id)
}
