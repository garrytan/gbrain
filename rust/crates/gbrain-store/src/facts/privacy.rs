//! The private-provenance policy of a fact read: `privateProvenanceFilterUnderPolicy('facts')`
//! (src/core/search/private-visibility.ts), which PGLite adds to a read that passes
//! `excludePrivate`. rust/docs/store/facts.md names the file and line of every rule below.
//!
//! The policy is the one PGLite renders with no caller record (the empty identity, no folder
//! rule satisfied, no lineage read), or for a record of only a reader identity and a
//! private-readable grant: the entity gate then judges by both, and the provenance page by the
//! identity on the caller's own member page only (`member_page`). The TypeScript member refuses
//! any other caller before it reads. Two process settings change that rendering, and the member passes both:
//! `honor_aliases` (`visibility.honor_aliases`) and `entity_privacy` (false when an operator
//! relaxed remote privacy, which drops the privacy part of the entity-page gate only).
//!
//! A page read (getRecentSalience, getSalienceScores, findAnomalies) applies the page policy
//! `privatePagesFilterForCaller(p)` with the same rendering: `page_hidden` below, where
//! `entity_privacy` says whether the privacy part applies (it does unless an operator relaxed it).
//!
//! Every rendering ends with the owner-only test (owner_only.rs), in the form the member read off
//! the text (`owner_only`): the member-access part of each page the policy judges (the page of a
//! page read, a fact's provenance, entity and holding pages) and the fact itself.
//!
//! Folder rules and pending prefixes come from `access_rules.rs`. A page counts as stamped
//! (`folder_rule_ids IS NOT NULL`) when its source holds access state and a rule covers its slug,
//! judged against the rules as they are now. A page read's policy can carry the rule ids the
//! caller satisfies (`satisfied_rule_ids`) and the pending prefixes its record holds
//! (`folder_coverage`), which the member sends only for the caller's own identity
//! ([`FolderAccess`]): a stamped page passes the member-access part when the caller satisfies
//! every rule over it and no prefix in the record covers its slug. With none of them, a stamped
//! page fails the member-access part and a page under a pending prefix fails the full form. The
//! store checks the live pending prefixes as well, so it hides at least what PGLite hides. The
//! provenance test (`derived`) counts only rules that cover derived pages
//! (`gbrain_access_lineage_rules`).
//! The row-level-security part (`gbrain_access_state_unreadable()`) is always false. Slug aliases and rename history come from `aliases.rs`
//! ([`read_slug_alias`], [`renamed_to`]), so an origin a rename moved is followed as PGLite
//! follows it, for the fact rules and for `page_hidden` alike.
//!
//! The owner-only rule is the one part of the member-access test the store can answer for a page: a page of an
//! owner-only source, and a concept or question synthesized from one, is hidden (`OwnerOnlyForm::Fn`), or every page
//! is while the brain holds an owner-only source or has held owner-only data (`OwnerOnlyForm::Closed`). `owner_only_marks` (`owner_only_marks.rs`) keeps a
//! page hidden after its owner-only input is deleted for good, as SQL's delete trigger does. A fact read applies the rule
//! to the provenance page, the entity and holding pages, and the fact row itself (`ownerOnlyFactSql`: a fact of an
//! owner-only source, marked, or derived from an owner-only row through `derivation_inputs`, `owner_only.rs`).
//!
//! The owner-only sources are read once per read, on the first page it judges ([`OwnerOnlyCache`]): the page reads
//! (`searchVector`, the link, alias, salience and page-read members) each keep one, so a read of many pages does not
//! scan the sources for each.

use super::FactRecord;
use crate::access_flag::RESTRICTIONS_PRESENT_KEY;
use crate::access_policy::{kept_rules, retired_rules};
use crate::access_rules::{
    AccessRuleRecord, folder_rules, pending_covers, rule_covers, stamped, valid_prefix,
};
use crate::aliases::{read_slug_alias, renamed_to};
use crate::keys;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::owner_only::{OwnerOnlyForm, OwnerOnlySources};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::timeline_queries::jsonb_field_text;
use crate::{Result, StoreError};
use serde::Deserialize;
use serde_json::{Map, Value};

/// The policy settings the TypeScript member read from the rendered SQL.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyPolicy {
    /// `honorAliases()`: a page with no `visibility` and a private `access` or
    /// `confidentiality` value is private.
    pub honor_aliases: bool,
    /// `privacyForCaller`: the entity and holding pages are judged by the privacy part too.
    pub entity_privacy: bool,
    /// The caller's reader identity (`member:<id>` and `group:<g>` principals) that the page
    /// policy judges a page's readers by (`readersAllowedSql`). Empty for the no-caller rendering.
    /// The fact policy judges the entity and holding pages by it, and the provenance page only
    /// when that page is `member_page`.
    #[serde(default)]
    pub identity: Vec<String>,
    /// The fact policy's member-page case (`privateProvenanceFilterUnderPolicy`): the caller's own
    /// member page (`memory/members/<member>`), the one provenance page judged by `identity`;
    /// every other provenance page keeps the empty identity. None for a page read, for the
    /// no-caller rendering and for `privateFactFilterForCaller`, which has no such case.
    #[serde(default)]
    pub member_page: Option<String>,
    /// The caller's private-readable grant (`orPrivateReadableSource`): a page of one of these
    /// sources that is not a pinned question passes the privacy part.
    #[serde(default)]
    pub private_readable_sources: Vec<String>,
    /// `remoteProvenanceFloorSql('facts')`, the remote floor: only the provenance page is judged
    /// (`privateProvenanceFilterFragment`), with no entity or holding-page gate.
    #[serde(default)]
    pub provenance_only: bool,
    /// The owner-only test the rendered policy ends with (`ownerOnlyAllowedSql`,
    /// `ownerOnlyFactAllowedSql`): its form, read off the text by the TypeScript member. Absent
    /// takes `closed`, which hides the most.
    #[serde(default)]
    pub owner_only: OwnerOnlyForm,
    /// The caller renders the short member-access form (`CallerAccess.restricted` false:
    /// `page_readers IS NULL AND folder_rule_ids IS NULL`), so a page that names readers fails
    /// whatever the identity. The store's own flag (`access.restrictions_present`) decides the
    /// rest: unset, nothing else applies, as the short form says; set (the caller's flag read was
    /// stale), the full form's origin walk applies too. See [`readers_allowed`]. The remote floor
    /// (`provenance_only`) is the exception: it judges the short form alone, as the SQL does.
    #[serde(default)]
    pub open: bool,
    /// The folder rules the caller satisfies (`CallerAccess.satisfiedRuleIds`, `source:rule_id`).
    /// A page whose stamped rules are all in it passes the folder test (`folderRulesAllowedSql`),
    /// judged for `identity` only, as `satisfiedFor` does. Empty for the no-caller rendering.
    #[serde(default)]
    pub satisfied_rule_ids: Vec<String>,
    /// The prefixes the caller's record reads as nobody (`CallerAccess.folderCoverage`,
    /// `coverageSql`): a page under one is hidden, as a page under a pending prefix the store
    /// holds is. An entry with an invalid source id or prefix hides every page.
    #[serde(default)]
    pub folder_coverage: Vec<FolderCoverage>,
    /// The policy is a caller record's rendering (`coverageSql` inside a record): the record's
    /// `folder_coverage` is the whole pending test, so a prefix the store holds pending but the
    /// record does not name hides nothing. Unset, the store's pending prefixes are read live, as
    /// the no-caller rendering reads them.
    #[serde(default)]
    pub caller_record: bool,
    /// The owner read rule (`ownerReadPolicyFragment`, the opt-in off): a derived page's origins are
    /// judged by `identity` (`gbrain_access_origin_hidden_for`: an origin that names readers closes
    /// the page only when none of them is a principal of `identity`, and a stamped rule the caller
    /// does not satisfy or a pending prefix closes it as for any caller) instead of by any reader
    /// list (`gbrain_access_origin_restricted`).
    #[serde(default)]
    pub owner_read: bool,
    /// The fact policy of a local owner reading with privacy off (`hidePrivate` false): its text
    /// judges the provenance page by the member-access part only, with no privacy part. Only the
    /// TypeScript member's exact owner-record match sets it; every other policy judges the
    /// provenance page by the privacy part too.
    #[serde(default)]
    pub provenance_privacy_off: bool,
    /// The owner lineage read's fact policy (`privateProvenanceFilterUnderPolicy` with a lineage page, GST-2490,
    /// the owner's opt-in off and no audience): a provenance page that is neither `member_page` nor another
    /// member page (`memory/members/`) is judged by `identity` under the owner read rule (`lineageAccessSql`,
    /// the origin test of `gbrain_access_origin_hidden_for`); the member pages are judged as without it, by
    /// the ordinary origin test. Only the TypeScript member's owner lineage record match sets it, with
    /// `owner_read` for the entity and holding pages.
    #[serde(default)]
    pub owner_lineage: bool,
    /// The labelled-only conjunct (`labelledOnlySql`, GBRA-108 design 1): the page names one of the identities
    /// (`page_readers && identity`) or has a folder rule in `satisfied_rule_ids` (`folder_rule_ids && satisfied`),
    /// ANDed with the rest of the policy, so it only narrows. A stored write's writer carries it with no lineage (a write
    /// never reads through it); a remote read carries it with `lineage` when `access.members_read_lineage` is on. Judged
    /// by the page policies ([`page_hidden`]), by the version judgment ([`live_labelled`]) and by the fact gate
    /// ([`hidden_by_private_provenance`], the caller's own member page); the entity and holding pages of a fact are
    /// judged without it, as `privateEntityFilterForCaller` does.
    #[serde(default)]
    pub labelled_only: Option<Box<LabelledOnly>>,
}

/// The terms of [`PrivacyPolicy::labelled_only`]: every principal a labelled-only writer may be named by, and the folder
/// rules it satisfies (each already validated by the TypeScript member, as `labelledOnlySql` does; an invalid set is empty).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelledOnly {
    #[serde(default)]
    pub identity: Vec<String>,
    #[serde(default)]
    pub satisfied_rule_ids: Vec<String>,
    /// `access.members_read_lineage` is on for this read (`labelledOnlySql` with `lineage`): a derived page with no label
    /// of its own also passes when it has an origin and every origin names the caller ([`labelled_origin_for`]).
    #[serde(default)]
    pub lineage: bool,
    /// The fact gate's own-page case (`labelledOnlyFactSql`): the caller's member id. A fact passes only on
    /// `memory/members/<member>` while that page names `member:<member>`. None reads as `FALSE`: no fact passes.
    #[serde(default)]
    pub member: Option<String>,
}

/// One entry of [`PrivacyPolicy::folder_coverage`]: `''` covers the whole source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderCoverage {
    pub source_id: String,
    pub prefix: String,
}

/// The caller's folder access for one judged identity: the rules it satisfies and the prefixes
/// its record reads as nobody.
#[derive(Clone, Copy, Default)]
struct FolderAccess<'a> {
    satisfied: &'a [String],
    coverage: &'a [FolderCoverage],
    /// [`PrivacyPolicy::caller_record`]: `coverage` replaces the live pending prefixes.
    record: bool,
}

impl FolderAccess<'_> {
    /// `folderRulesAllowedSql`'s rule test: every rule in `rules` is satisfied.
    fn satisfies_all<'r>(&self, mut rules: impl Iterator<Item = &'r AccessRuleRecord>) -> bool {
        rules.all(|r| {
            self.satisfied
                .iter()
                .any(|id| id.split_once(':') == Some((r.source_id.as_str(), r.rule_id.as_str())))
        })
    }

    /// `coverageSql` over the record's prefixes: a page under one, or any page when an entry is
    /// not valid, reads as nobody.
    fn covers(&self, page: &PageRecord) -> bool {
        self.coverage.iter().any(|c| {
            !crate::sources::valid_source_id(&c.source_id)
                || (!c.prefix.is_empty() && !valid_prefix(&c.prefix))
                || (c.source_id == page.source_id
                    && (c.prefix.is_empty() || rule_covers(&page.slug, &c.prefix)))
        })
    }
}

/// The owner-only sources of one read, found on the first page the read judges and kept for the rest (a read that
/// judges no page, or runs with no policy, never looks at the sources).
#[derive(Default)]
pub(crate) struct OwnerOnlyCache(Option<OwnerOnlySources>);

impl OwnerOnlyCache {
    /// [`page_hidden_with`] with the sources of this read.
    pub(crate) fn page_hidden(
        &mut self,
        read: &dyn KvRead,
        page: &PageRecord,
        policy: &PrivacyPolicy,
    ) -> Result<bool> {
        let sources = match &mut self.0 {
            Some(sources) => sources,
            None => self.0.insert(OwnerOnlySources::read(read)?),
        };
        page_hidden_with(read, page, policy, sources)
    }
}

/// `PRIVACY_ALIASES`: the keys a page may carry instead of `visibility`, with their private values.
const PRIVACY_ALIASES: [(&str, &[&str]); 2] = [
    ("access", &["private", "restricted", "confidential"]),
    (
        "confidentiality",
        &["confidential", "secret", "private", "restricted"],
    ),
];

/// `edgeTrimSql`: the ASCII blanks, plus the Unicode spaces a UTF-8 database adds.
pub(crate) const EDGE_SPACE: &[char] = &[
    ' ', '\t', '\n', '\u{0B}', '\u{0C}', '\r', '\u{A0}', '\u{1680}', '\u{2000}', '\u{2001}',
    '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}',
    '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
];

/// Whether the policy hides `row`: the fact is owner-only, its provenance page
/// (`source_markdown_slug`) fails the page policy, or its entity page or holding page fails the
/// entity gate. A soft-deleted page still counts, as its row stays in `pages`.
pub(crate) fn hidden_by_private_provenance(
    read: &dyn KvRead,
    row: &FactRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let owner_only = &OwnerOnlySources::read(read)?;
    // `ownerOnlyFactSql(facts, form)` for a caller that is not the owner: a fact of an owner-only
    // source, marked, or derived from an owner-only row (`Fn`), or any fact while the brain holds an
    // owner-only source (`Closed`).
    if owner_only.fact_hidden(read, policy.owner_only, row.id, &row.source_id)? {
        return Ok(true);
    }
    // `labelledOnlyFactSql`: a labelled-only caller reads a fact only on its own member page.
    if let Some(labelled) = &policy.labelled_only
        && !own_page_fact(read, row, labelled)?
    {
        return Ok(true);
    }
    // The remote floor (`provenance_only`) of a caller that renders the short member-access form
    // (`open`) has no origin test, whatever the store's restriction flag says, as the forget floor.
    let restricted = !(policy.provenance_only && policy.open);
    if hidden_by_provenance_page_with(read, row, policy, restricted, owner_only)? {
        return Ok(true);
    }
    if policy.provenance_only {
        return Ok(false);
    }
    let held = match (&row.entity_slug, &row.source_markdown_slug) {
        (Some(_), Some(slug)) if holding_slug(slug) => Some(slug),
        _ => None,
    };
    for slug in [row.entity_slug.as_ref(), held].into_iter().flatten() {
        let Some(page) = read_page(read, &row.source_id, slug)? else {
            continue;
        };
        if page_hidden_parts(read, &page, policy, owner_only, None)? {
            return Ok(true);
        }
    }
    // GBRA-574: a bare name key reads as the page later written at `<dir>/<key>`, so that page's
    // privacy covers the fact too (`privateEntityFilterForCaller`'s `keyed`).
    if let Some(entity) = row.entity_slug.as_deref()
        && !entity.contains('/')
    {
        for dir in NAME_KEY_PAGE_DIRS {
            let Some(page) = read_page(read, &row.source_id, &format!("{dir}/{entity}"))? else {
                continue;
            };
            if page_hidden_parts(read, &page, policy, owner_only, None)? {
                return Ok(true);
            }
        }
    }
    // `sharedHeldRuledSql`: a held fact is hidden when its entity sits under a folder rule (live,
    // whatever the access state) the caller does not satisfy, or under a pending prefix. The rules the
    // caller satisfies are `satisfied_rule_ids`, as `source:rule` ids (`gbrain_access_folder_rules`).
    match (&row.entity_slug, held) {
        (Some(entity), Some(_)) => {
            let unsatisfied = folder_rules(read, &row.source_id, entity)?.iter().any(|r| {
                let id = format!("{}:{}", r.source_id, r.rule_id);
                !policy.satisfied_rule_ids.contains(&id)
            });
            Ok(unsatisfied || pending_covers(read, &row.source_id, entity)?)
        }
        _ => Ok(false),
    }
}

/// `NAME_KEY_PAGE_DIRS` (src/core/entities/basename-dirs.ts): the directories whose page at
/// `<dir>/<key>` covers a bare name key's facts for privacy.
const NAME_KEY_PAGE_DIRS: [&str; 8] = [
    "people",
    "companies",
    "hosts",
    "projects",
    "concepts",
    "funds",
    "orgs",
    "organizations",
];

/// Whether the row's provenance page (`source_markdown_slug`) fails the page policy: the
/// provenance half of the policy above, and by itself `privateProvenanceFilterFragment` (the
/// remote provenance floor, `remoteProvenanceFloorSql`, for a caller that is not labelled-only),
/// which judges no entity or holding page. A missing page hides nothing. `restricted` is the
/// caller record's flag: false (a brain that holds no member-access restrictions) renders the
/// member-access part as `page_readers IS NULL AND folder_rule_ids IS NULL`, with no origin test.
/// Both forms end with the page owner-only test in the policy's form.
pub(crate) fn hidden_by_provenance_page(
    read: &dyn KvRead,
    row: &FactRecord,
    policy: &PrivacyPolicy,
    restricted: bool,
) -> Result<bool> {
    hidden_by_provenance_page_with(
        read,
        row,
        policy,
        restricted,
        &OwnerOnlySources::read(read)?,
    )
}

/// [`hidden_by_provenance_page`] with the owner-only sources the caller already read.
fn hidden_by_provenance_page_with(
    read: &dyn KvRead,
    row: &FactRecord,
    policy: &PrivacyPolicy,
    restricted: bool,
    owner_only: &OwnerOnlySources,
) -> Result<bool> {
    let Some(slug) = &row.source_markdown_slug else {
        return Ok(false);
    };
    let Some(page) = read_page(read, &row.source_id, slug)? else {
        return Ok(false);
    };
    let access = if restricted {
        // The owner lineage read judges every page that is not a member page as the owner, under the owner read rule.
        let lineage_page = policy.owner_lineage
            && policy.member_page.as_deref() != Some(slug.as_str())
            && !slug.starts_with(super::MEMBER_PAGE_PREFIX);
        let (identity, owner_read) = if lineage_page {
            (policy.identity.as_slice(), true)
        } else {
            (
                provenance_identity(policy, slug),
                policy.owner_read && !policy.owner_lineage,
            )
        };
        member_access_allows_by(read, &page, identity, policy, true, owner_only, owner_read)?
    } else {
        !names_readers(&page)
            && stamped_rules(read, &page)?.is_empty()
            && !owner_only.page_hidden(read, &page, policy.owner_only)?
    };
    Ok(!(access
        && (policy.provenance_privacy_off || privacy_allows(read, &page, policy.honor_aliases)?)))
}

/// The identity the provenance page at `slug` is judged by: the caller's on its own member page,
/// else the empty identity (`readPolicyFragment('pp', [], ...)`).
fn provenance_identity<'a>(policy: &'a PrivacyPolicy, slug: &str) -> &'a [String] {
    if policy.member_page.as_deref() == Some(slug) {
        &policy.identity
    } else {
        &[]
    }
}

/// [`page_hidden_with`], reading the owner-only sources for this one page.
pub(crate) fn page_hidden(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    page_hidden_with(read, page, policy, &OwnerOnlySources::read(read)?)
}

/// Whether the page policy `privatePagesFilterForCaller(p)` hides `page`: the member-access part
/// for the policy's identity (named readers, origin readers, the owner-only rule), then the privacy
/// part unless `entity_privacy` is false, which a page of a private-readable source passes unless it
/// is a pinned question. It is the test the entity gate puts on an entity page. A read over many
/// pages reads `owner_only` once ([`OwnerOnlySources::read`]).
pub(crate) fn page_hidden_with(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
    owner_only: &OwnerOnlySources,
) -> Result<bool> {
    page_hidden_parts(
        read,
        page,
        policy,
        owner_only,
        policy.labelled_only.as_deref(),
    )
}

/// [`page_hidden_with`] with the labelled-only conjunct to apply: the policy's own, or none (the entity and holding pages
/// of a fact, which `privateEntityFilterForCaller` judges by the caller's ordinary access).
fn page_hidden_parts(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
    owner_only: &OwnerOnlySources,
    labelled: Option<&LabelledOnly>,
) -> Result<bool> {
    let allowed = member_access_allows(read, page, &policy.identity, policy, false, owner_only)?
        && (!policy.entity_privacy
            || private_source_open(page, policy)
            || privacy_allows(read, page, policy.honor_aliases)?)
        && match labelled {
            Some(labelled) => page_labelled(read, page, labelled, policy.caller_record)?,
            None => true,
        };
    Ok(!allowed)
}

/// `holdingSlugSql`: `memory/unattributed`, or a slug ending in `/memory/unattributed`.
pub(super) fn holding_slug(slug: &str) -> bool {
    slug == "memory/unattributed" || slug.ends_with("/memory/unattributed")
}

/// The member-access part (`accessAllowedSql`): the page's readers allow `identity`, and the page
/// is not owner-only (`ownerOnlyAllowedSql`, in the policy's form). `derived` judges the page as
/// the origin of a fact (`readPolicyFragment(..., derived = true)`).
fn member_access_allows(
    read: &dyn KvRead,
    page: &PageRecord,
    identity: &[String],
    policy: &PrivacyPolicy,
    derived: bool,
    owner_only: &OwnerOnlySources,
) -> Result<bool> {
    member_access_allows_by(
        read,
        page,
        identity,
        policy,
        derived,
        owner_only,
        policy.owner_read,
    )
}

/// [`member_access_allows`] with the origin test `owner_read` names (the policy's own `owner_read`, or the form
/// [`owner_reads_page`] puts on each of its two reads).
fn member_access_allows_by(
    read: &dyn KvRead,
    page: &PageRecord,
    identity: &[String],
    policy: &PrivacyPolicy,
    derived: bool,
    owner_only: &OwnerOnlySources,
    owner_read: bool,
) -> Result<bool> {
    // `satisfiedFor(identity)`: the record's satisfied rules hold for the record's own identity;
    // `coverageSql` reads the record's coverage whatever identity is judged.
    let satisfied: &[String] = if !identity.is_empty() && identity == policy.identity.as_slice() {
        &policy.satisfied_rule_ids
    } else {
        &[]
    };
    let folders = FolderAccess {
        satisfied,
        coverage: &policy.folder_coverage,
        record: policy.caller_record,
    };
    Ok(readers_allowed(
        read,
        page,
        identity,
        folders,
        policy.open,
        derived,
        owner_read,
    )? && !owner_only.page_hidden(read, page, policy.owner_only)?)
}

/// `accessAllowedSql(alias, identity)` for one page under a caller record's page policy: the
/// member-access part alone (readers, folder rules, restricted origin, owner-only), with no privacy
/// part (the who-can-read report, src/commands/access.ts).
pub(crate) fn page_access_allowed(
    read: &dyn KvRead,
    page: &PageRecord,
    identity: &[String],
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let owner_only = OwnerOnlySources::read(read)?;
    member_access_allows(read, page, identity, policy, false, &owner_only)
}

/// Whether `page` passes both reads `ownerReachesFact` puts on a page of the fact:
/// `ownerReadPolicyFragment('pp', identity, satisfied)` (GST-2490's owner read rule with the opt-in
/// off: the page's readers and folder rules for the owner's identity, the lineage origin test of
/// `gbrain_access_origin_hidden_for`, then the privacy part; no owner-only test, as the owner's)
/// and `readPolicyFragment('pp', identity, true, satisfied)` (the member-access part in the
/// policy's form, then the privacy part). The identity and the satisfied rules are the policy's; so are the
/// caller record's folder coverage and whether the texts are a record's rendering (`caller_record`).
pub(crate) fn owner_reads_page(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let identity = policy.identity.as_slice();
    let satisfied = policy.satisfied_rule_ids.as_slice();
    let folders = FolderAccess {
        satisfied,
        coverage: &policy.folder_coverage,
        record: policy.caller_record,
    };
    // The owner read rule is the `owner_read` form of the member-access part (the origin test of
    // `gbrain_access_origin_hidden_for`); the member read rule that follows is the every-caller form.
    if !readers_allowed(read, page, identity, folders, false, false, true)?
        || !privacy_allows(read, page, policy.honor_aliases)?
    {
        return Ok(false);
    }
    let owner_only = OwnerOnlySources::read(read)?;
    Ok(
        member_access_allows_by(read, page, identity, policy, false, &owner_only, false)?
            && privacy_allows(read, page, policy.honor_aliases)?,
    )
}

/// `folderRulesAllowedSql(alias, satisfied)` for one page under a caller record's page policy:
/// every rule stamped on the page is in `satisfied`, and no prefix of the record (or, outside a
/// record, no pending prefix the store holds) covers it.
pub(crate) fn page_folder_rules_allowed(
    read: &dyn KvRead,
    page: &PageRecord,
    satisfied: &[String],
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let pending = pending_covers(read, &page.source_id, &page.slug)?;
    let rules = if policy.caller_record && pending {
        kept_rules(read, &page.source_id, page.id)?
    } else {
        stamped_rules(read, page)?
    };
    let folders = FolderAccess {
        satisfied,
        coverage: &policy.folder_coverage,
        record: policy.caller_record,
    };
    Ok(folders.satisfies_all(rules.iter())
        && !folders.covers(page)
        && (policy.caller_record || !pending))
}

/// `orPrivateReadableSource`: the page's source is in the private-readable grant and the page
/// does not carry `pinned_question`.
fn private_source_open(page: &PageRecord, policy: &PrivacyPolicy) -> bool {
    policy.private_readable_sources.contains(&page.source_id)
        && !page.frontmatter.contains_key("pinned_question")
}

/// Whether the policy hides a version of `page` (`callerReadersAllowedSql(pv, 'snapshot') AND
/// privacyForCaller(p, privateSnapshotFilterFragment(pv))`): the version names readers none of
/// which is in the policy's identity, or, with `entity_privacy`, its own fields are private and
/// the page is not open through the private-readable grant (judged on the page, as
/// `orPrivateReadableSource(p, …)` is). Only the version's type and frontmatter count otherwise.
pub(crate) fn version_hidden(
    page: &PageRecord,
    page_type: &str,
    fm: &Map<String, Value>,
    policy: &PrivacyPolicy,
) -> bool {
    let readers_allow = !fm.contains_key("readable_by")
        || access_readers(fm).is_some_and(|r| r.iter().any(|id| policy.identity.contains(id)));
    let privacy_allows = !policy.entity_privacy
        || private_source_open(page, policy)
        || snapshot_fields_allow(page_type, fm, policy.honor_aliases);
    !(readers_allow && privacy_allows)
}

/// Whether `getVersions` under a caller page policy hides a version of `page`:
/// `callerReadersAllowedSql(pv, 'snapshot')` judges the version's readers by the policy's identity,
/// then, with `entity_privacy`, `privacyForCaller(p, privateSnapshotFilterFragment(pv))` judges its
/// own fields (the page's private-readable source opens them) and a pinned question stays hidden.
/// With no identity and no grant it is `version_hidden`.
pub(crate) fn caller_version_hidden(
    page: &PageRecord,
    page_type: &str,
    fm: &Map<String, Value>,
    policy: &PrivacyPolicy,
    live_labelled: Option<bool>,
) -> bool {
    let readers_allowed = !fm.contains_key("readable_by")
        || access_readers(fm)
            .is_some_and(|readers| readers.iter().any(|r| policy.identity.contains(r)));
    !readers_allowed
        || version_unlabelled(fm, policy, live_labelled)
        || (policy.entity_privacy
            && (fm.contains_key("pinned_question")
                || !(private_source_open(page, policy)
                    || snapshot_fields_allow(page_type, fm, policy.honor_aliases))))
}

/// The labelled-only conjunct of a version snapshot (`callerReadersAllowedSql(pv, 'snapshot')`): the version's own readers
/// name the caller, or its live page passes `labelledOnlySql('sp', access, false)` (`live_labelled`, from
/// [`live_labelled`]). True when the policy has the conjunct and neither holds.
fn version_unlabelled(
    fm: &Map<String, Value>,
    policy: &PrivacyPolicy,
    live_labelled: Option<bool>,
) -> bool {
    let Some(labelled) = &policy.labelled_only else {
        return false;
    };
    let named = access_readers(fm)
        .is_some_and(|readers| readers.iter().any(|r| labelled.identity.contains(r)));
    !named && live_labelled != Some(true)
}

/// Whether a version's successor (the next version of the page) withholds the version's change
/// reason from a policy reader (`replacedBecauseSql`): the successor names readers none of which is
/// in the policy's identity, or its own fields are private (`privateSnapshotFilterFragment`). The
/// successor is judged by its fields alone, whatever the policy's entity privacy part or
/// private-readable grant, as the SQL does, and by the labelled-only conjunct of a version
/// ([`version_unlabelled`]) when the policy has one.
pub(crate) fn successor_withholds_reason(
    page_type: &str,
    fm: &Map<String, Value>,
    policy: &PrivacyPolicy,
    live_labelled: Option<bool>,
) -> bool {
    let readers_allowed = !fm.contains_key("readable_by")
        || access_readers(fm)
            .is_some_and(|readers| readers.iter().any(|r| policy.identity.contains(r)));
    !readers_allowed
        || version_unlabelled(fm, policy, live_labelled)
        || !snapshot_fields_allow(page_type, fm, policy.honor_aliases)
}

/// `frontmatter ->> key`.
fn text(frontmatter: &Map<String, Value>, key: &str) -> Option<String> {
    frontmatter.get(key).and_then(jsonb_field_text)
}

/// `derivedPageSql`: an atom, a question, or a concept with `synthesized_by`.
fn derived_page(page: &PageRecord) -> bool {
    derived_fields(&page.page_type, &page.frontmatter)
}

/// `derivedPageSql` over a row's type and frontmatter (a page or one of its versions).
fn derived_fields(page_type: &str, frontmatter: &Map<String, Value>) -> bool {
    matches!(page_type, "atom" | "question")
        || (page_type == "concept" && text(frontmatter, "synthesized_by").is_some())
}

/// A concept-provenance input of a question or synthesized concept (`gbrain_access_origin_restricted`
/// and `derivedOriginPrivateSql` both read this link).
pub(crate) fn concept_inputs(read: &dyn KvRead, page: &PageRecord) -> Result<Vec<PageRecord>> {
    let mut inputs = Vec::new();
    for link in out_links(read, page.id)? {
        if link.link_source.as_deref() == Some("concept-provenance")
            && link.link_type == "synthesized_from"
            && let Some(input) = read_page_by_id(read, link.to_page_id)?
        {
            inputs.push(input);
        }
    }
    Ok(inputs)
}

/// The slugs a page names in `derived_from` (a list, or one string), each without a trailing
/// `.md`; `None` when the field is neither.
pub(crate) fn declared_slugs(frontmatter: &Map<String, Value>) -> Option<Vec<String>> {
    let items: Vec<&Value> = match frontmatter.get("derived_from")? {
        Value::Array(items) => items.iter().collect(),
        one @ Value::String(_) => vec![one],
        _ => return None,
    };
    Some(
        items
            .into_iter()
            .filter_map(jsonb_field_text)
            .map(|s| s.strip_suffix(".md").map(str::to_string).unwrap_or(s))
            .collect(),
    )
}

/// The page at `slug` in `source_id`, when it passes `test`.
fn page_where(
    read: &dyn KvRead,
    source_id: &str,
    slug: Option<&str>,
    test: impl Fn(&PageRecord) -> Result<bool>,
) -> Result<bool> {
    let Some(slug) = slug else {
        return Ok(false);
    };
    match read_page(read, source_id, slug)? {
        Some(page) => test(&page),
        None => Ok(false),
    }
}

/// Any page of `slugs` in `source_id` that passes `test`.
fn any_page_where(
    read: &dyn KvRead,
    source_id: &str,
    slugs: &[String],
    test: impl Fn(&PageRecord) -> Result<bool>,
) -> Result<bool> {
    for slug in slugs {
        if page_where(read, source_id, Some(slug), &test)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The slugs an origin reference names in `source_id` (`gbrain_access_origin_restricted`): the
/// slug, the slug its `slug_aliases` row resolves to (any notes), and every slug
/// `slug_rename_history` moved it to.
fn origin_slugs(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Vec<String>> {
    let mut slugs = vec![slug.to_string()];
    if let Some(alias) = read_slug_alias(read, source_id, slug)? {
        slugs.push(alias.canonical_slug);
    }
    slugs.extend(renamed_to(read, source_id, slug)?);
    Ok(slugs)
}

/// Any page an origin reference names in `source_id` ([`origin_slugs`]) that passes `test`.
fn origin_where(
    read: &dyn KvRead,
    source_id: &str,
    slug: Option<&str>,
    test: impl Fn(&PageRecord) -> Result<bool>,
) -> Result<bool> {
    let Some(slug) = slug else {
        return Ok(false);
    };
    any_page_where(read, source_id, &origin_slugs(read, source_id, slug)?, test)
}

/// A page that names readers: `frontmatter ? 'readable_by'`.
fn names_readers(page: &PageRecord) -> bool {
    page.frontmatter.contains_key("readable_by")
}

/// The folder rules stamped on a page (`folder_rule_ids`): none unless its source holds access
/// state, else every rule whose prefix its slug starts with.
///
/// A page whose kept stamp (`access_policy::retired_rules`) names a rule that was removed since
/// the last restamp also carries that rule, as a rule nobody satisfies, so it stays hidden until
/// the restamp, as SQL keeps the deleted id in `folder_rule_ids`. A page with no kept stamp keeps
/// the live rules alone. Every privacy read takes its rules from here.
pub(crate) fn stamped_rules(read: &dyn KvRead, page: &PageRecord) -> Result<Vec<AccessRuleRecord>> {
    let mut rules = if stamped(read, &page.source_id, &page.slug)? {
        folder_rules(read, &page.source_id, &page.slug)?
    } else {
        Vec::new()
    };
    rules.extend(retired_rules(read, &page.source_id, page.id)?);
    Ok(rules)
}

/// The folder rules a policy judges `page` by (`folder_rule_ids`). A caller record's rendering reads no live pending
/// prefix, so a page under one (`kept`) is judged by the ids its last stamp kept, not the rules installed since;
/// elsewhere the live pending prefix hides the page, and the kept ids equal the rules after the restamp ([`stamped_rules`]).
fn page_rules(read: &dyn KvRead, page: &PageRecord, kept: bool) -> Result<Vec<AccessRuleRecord>> {
    if kept {
        kept_rules(read, &page.source_id, page.id)
    } else {
        stamped_rules(read, page)
    }
}

/// The short member-access form `page_readers IS NULL AND folder_rule_ids IS NULL`: the page names no readers and no
/// folder rule is stamped on it.
pub(crate) fn names_no_readers_or_rules(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(!names_readers(page) && stamped_rules(read, page)?.is_empty())
}

/// v305's restricted origin: it names readers, a stamped rule that covers derived pages
/// (`gbrain_access_lineage_rules(...) IS NOT NULL`) covers it, or a pending prefix covers it.
fn origin_closed(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(names_readers(page)
        || stamped_rules(read, page)?.iter().any(|r| r.covers_derived)
        || pending_covers(read, &page.source_id, &page.slug)?)
}

/// `frontmatter ->> 'visibility' = 'private'`.
fn explicitly_private(page: &PageRecord) -> bool {
    text(&page.frontmatter, "visibility").as_deref() == Some("private")
}

/// `NOBODY`: the readers of a `readable_by` value that is present but malformed.
const NOBODY: &str = "!nobody";

/// `ACCESS_ID_RE`, `^[a-z0-9][a-z0-9._-]{0,63}$`.
pub(crate) fn access_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

/// `gbrain_access_norm_readers` for one entry: trimmed of ASCII spaces and ASCII lower-cased, a
/// bare or `member:` id reads as `member:<id>`, a `group:` id as itself; anything else is none.
fn norm_reader(raw: &str) -> Option<String> {
    let v = raw.trim_matches(' ').to_ascii_lowercase();
    if let Some(group) = v.strip_prefix("group:") {
        return access_id(group).then(|| v.clone());
    }
    let id = v.strip_prefix("member:").unwrap_or(&v);
    access_id(id).then(|| format!("member:{id}"))
}

/// `gbrain_access_readers(frontmatter)` (schema migration v282), the `page_readers` column: none
/// without a `readable_by` key; the sorted, distinct principals of a string or of a list of 1 to
/// 256 strings that all normalize; `['!nobody']` for any other value.
pub(crate) fn access_readers(frontmatter: &Map<String, Value>) -> Option<Vec<String>> {
    let value = frontmatter.get("readable_by")?;
    let items: Option<Vec<&str>> = match value {
        Value::String(one) => Some(vec![one.as_str()]),
        Value::Array(items) if (1..=256).contains(&items.len()) => {
            items.iter().map(Value::as_str).collect()
        }
        _ => None,
    };
    let readers: Option<Vec<String>> =
        items.and_then(|items| items.into_iter().map(norm_reader).collect());
    Some(match readers {
        Some(mut readers) => {
            readers.sort();
            readers.dedup();
            readers
        }
        None => vec![NOBODY.to_string()],
    })
}

/// The member-access part (`accessAllowedSql`) for `identity`: no readers of its own or readers
/// that name one of its principals (`readersAllowedSql`), no folder rule the caller does not
/// satisfy (`folderRulesAllowedSql` with an empty satisfied set) and no restricted origin. A
/// caller record's rendering reads its own coverage for the pending test, any other the store's
/// pending prefixes. With
/// `open` (the short form) a page that names readers or is stamped fails for any identity, and the
/// rest runs only when the store's flag is set: unset, no stored page names readers. The full form
/// also fails a page under a pending prefix, and with `derived` counts only the rules that cover
/// derived pages.
fn readers_allowed(
    read: &dyn KvRead,
    page: &PageRecord,
    identity: &[String],
    folders: FolderAccess<'_>,
    open: bool,
    derived: bool,
    owner_read: bool,
) -> Result<bool> {
    let pending = pending_covers(read, &page.source_id, &page.slug)?;
    let rules = page_rules(read, page, folders.record && pending)?;
    if open && (names_readers(page) || !restrictions_present(read)?) {
        return Ok(!names_readers(page) && rules.is_empty());
    }
    let folder_closed = if open {
        !rules.is_empty()
    } else if derived {
        !folders.satisfies_all(rules.iter().filter(|r| r.covers_derived))
    } else {
        !folders.satisfies_all(rules.iter())
    };
    if folder_closed || (!open && folders.covers(page)) || (!folders.record && pending) {
        return Ok(false);
    }
    if names_readers(page) && !readers_name(page, identity) {
        return Ok(false);
    }
    if plain_page(page) {
        return Ok(true);
    }
    let closed = if owner_read {
        origin_restricted_by(read, page, &|o| {
            Ok(pending_covers(read, &o.source_id, &o.slug)?
                || (names_readers(o) && !readers_name(o, identity))
                || !folders
                    .satisfies_all(stamped_rules(read, o)?.iter().filter(|r| r.covers_derived)))
        })?
    } else {
        origin_restricted_by(read, page, &|o| origin_closed(read, o))?
    };
    Ok(!closed)
}

/// The labelled-only conjunct (`labelledOnlySql` without lineage): the page's readers name one of `labelled.identity`
/// (`page_readers && identity`), or a folder rule stamped on it is in `labelled.satisfied_rule_ids`
/// (`folder_rule_ids && satisfied`). A page that names nobody and has no stamped rule is named by no one.
fn page_names_labelled(
    read: &dyn KvRead,
    page: &PageRecord,
    labelled: &LabelledOnly,
    record: bool,
) -> Result<bool> {
    if readers_name(page, &labelled.identity) {
        return Ok(true);
    }
    let kept = record && pending_covers(read, &page.source_id, &page.slug)?;
    Ok(page_rules(read, page, kept)?
        .iter()
        .any(|r| rule_satisfied(labelled, r)))
}

/// A page with no lineage to walk: its type is not atom, question, concept or event and it has no `derived_from` key
/// (the SQL guard `type IN (...) OR frontmatter ? 'derived_from'` of `lineageOriginAllowedSql` and `labelledOnlySql`).
fn plain_page(page: &PageRecord) -> bool {
    !matches!(
        page.page_type.as_str(),
        "atom" | "question" | "concept" | "event"
    ) && !page.frontmatter.contains_key("derived_from")
}

/// `labelledOnlySql(alias, access)` for a page read: the page names the caller ([`page_names_labelled`]), or, with
/// lineage, it is a derived page whose origins all do ([`labelled_origin_for`]).
fn page_labelled(
    read: &dyn KvRead,
    page: &PageRecord,
    labelled: &LabelledOnly,
    record: bool,
) -> Result<bool> {
    if page_names_labelled(read, page, labelled, record)? {
        return Ok(true);
    }
    Ok(labelled.lineage && !plain_page(page) && labelled_origin_for(read, page, labelled, record)?)
}

/// `labelledOnlySql('sp', access, false)`, the test a version snapshot gets of its live page: a folder rule the caller
/// satisfies covers it (the page's own readers do not label a version), or, with lineage, a derived page whose origins
/// all name the caller. `None` when the policy has no labelled-only conjunct.
pub(crate) fn live_labelled(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
) -> Result<Option<bool>> {
    let Some(labelled) = &policy.labelled_only else {
        return Ok(None);
    };
    let kept = policy.caller_record && pending_covers(read, &page.source_id, &page.slug)?;
    let ruled = page_rules(read, page, kept)?
        .iter()
        .any(|r| rule_satisfied(labelled, r));
    Ok(Some(
        ruled
            || (labelled.lineage
                && !plain_page(page)
                && labelled_origin_for(read, page, labelled, policy.caller_record)?),
    ))
}

/// `COALESCE(folder_rule_ids && satisfied, false)` for one stamped rule.
fn rule_satisfied(labelled: &LabelledOnly, rule: &AccessRuleRecord) -> bool {
    labelled
        .satisfied_rule_ids
        .iter()
        .any(|id| id.split_once(':') == Some((rule.source_id.as_str(), rule.rule_id.as_str())))
}

/// `gbrain_access_origin_labelled_for(id, source_id, type, frontmatter, identity, satisfied)` (schema migration v308),
/// in its order: an atom's source page, a question's or synthesized concept's inputs, a Life Chronicle event's depth page,
/// then (not instead) the declared `derived_from` pages. Each branch that applies must pass, and at least one must apply;
/// an origin that is missing, a list that is empty or holds a null, or one origin that names someone else fails closed.
fn labelled_origin_for(
    read: &dyn KvRead,
    page: &PageRecord,
    labelled: &LabelledOnly,
    record: bool,
) -> Result<bool> {
    let fm = &page.frontmatter;
    let source = page.source_id.as_str();
    let mut found = false;
    if page.page_type == "atom" {
        if !every_origin(
            read,
            source,
            text(fm, "source_slug").as_deref(),
            labelled,
            record,
        )? {
            return Ok(false);
        }
        found = true;
    } else if page.page_type == "question"
        || (page.page_type == "concept" && text(fm, "synthesized_by").is_some())
    {
        let inputs = concept_inputs(read, page)?;
        if inputs.is_empty() {
            return Ok(false);
        }
        for input in &inputs {
            if page_names_labelled(read, input, labelled, record)? {
                continue;
            }
            let own_origin = input.page_type == "atom"
                && every_origin(
                    read,
                    &input.source_id,
                    text(&input.frontmatter, "source_slug").as_deref(),
                    labelled,
                    record,
                )?;
            if !own_origin {
                return Ok(false);
            }
        }
        found = true;
    } else if page.page_type == "event" && life_chronicle(page) {
        if !every_origin(
            read,
            source,
            chronicle_depth(page).as_deref(),
            labelled,
            record,
        )? {
            return Ok(false);
        }
        found = true;
    }
    if let Some(items) = declared_items(fm) {
        if items.is_empty() {
            return Ok(false);
        }
        for item in &items {
            if !every_origin(read, source, item.as_deref(), labelled, record)? {
                return Ok(false);
            }
        }
        found = true;
    }
    Ok(found)
}

/// One origin reference of the labelled walk: the pages it names ([`origin_slugs`]) exist, at least one, and each names
/// the caller. `NOT EXISTS (...) OR EXISTS (... AND NOT LABELLED)` returns false in the SQL; a missing slug (a NULL)
/// resolves to no page.
fn every_origin(
    read: &dyn KvRead,
    source_id: &str,
    slug: Option<&str>,
    labelled: &LabelledOnly,
    record: bool,
) -> Result<bool> {
    let Some(slug) = slug else {
        return Ok(false);
    };
    let mut found = false;
    for origin in origin_slugs(read, source_id, slug)? {
        if let Some(page) = read_page(read, source_id, &origin)? {
            if !page_names_labelled(read, &page, labelled, record)? {
                return Ok(false);
            }
            found = true;
        }
    }
    Ok(found)
}

/// The items the labelled walk reads from `derived_from` (`jsonb_array_elements_text` over a list, or over a one-element
/// list holding a string), each with one trailing `.md` removed (`regexp_replace(x, '\.md$', '')`). A JSON null item is
/// kept as `None`: SQL reads it as a NULL slug that names no page, so the walk fails closed on it (unlike
/// [`declared_slugs`], which drops it). `None` for a value that is neither a list nor a string.
fn declared_items(frontmatter: &Map<String, Value>) -> Option<Vec<Option<String>>> {
    let items: Vec<&Value> = match frontmatter.get("derived_from")? {
        Value::Array(items) => items.iter().collect(),
        one @ Value::String(_) => vec![one],
        _ => return None,
    };
    Some(
        items
            .into_iter()
            .map(|item| {
                jsonb_field_text(item)
                    .map(|s| s.strip_suffix(".md").map(str::to_string).unwrap_or(s))
            })
            .collect(),
    )
}

/// `labelledOnlyFactSql`'s own-page case: the fact sits on `memory/members/<member>` (the caller's own member page, in the
/// fact's source), and that page names `member:<member>`. No member, or a malformed one, reads as `FALSE`. A policy that
/// carries lineage never reaches the store (the TypeScript member refuses the fact policy under lineage), so it errors.
fn own_page_fact(read: &dyn KvRead, row: &FactRecord, labelled: &LabelledOnly) -> Result<bool> {
    if labelled.lineage {
        return Err(StoreError::invalid(
            "a labelled-only fact read under lineage is not modelled",
        ));
    }
    let Some(member) = labelled.member.as_deref().filter(|m| access_id(m)) else {
        return Ok(false);
    };
    let own = format!("memory/members/{member}");
    if row.source_markdown_slug.as_deref() != Some(own.as_str()) {
        return Ok(false);
    }
    Ok(match read_page(read, &row.source_id, &own)? {
        Some(page) => readers_name(&page, &[format!("member:{member}")]),
        None => false,
    })
}

/// `page_readers && identity`: the page's readers name one of the principals.
fn readers_name(page: &PageRecord, identity: &[String]) -> bool {
    access_readers(&page.frontmatter)
        .is_some_and(|readers| readers.iter().any(|r| identity.contains(r)))
}

/// Whether the store's member-access flag (`access.restrictions_present`) is `'1'`.
fn restrictions_present(read: &dyn KvRead) -> Result<bool> {
    let key = keys::text(keys::CONFIG, &[RESTRICTIONS_PRESENT_KEY]);
    Ok(read.get(&key)?.as_deref() == Some(b"1".as_slice()))
}

/// The origin walk of `gbrain_access_origin_restricted(id, source_id, type, frontmatter)` (every caller,
/// `closes` = [`origin_closed`]) and of `gbrain_access_origin_hidden_for(...)` (an owner read, `closes` judges the
/// origin's readers by the reader's identity): whether an origin of the page closes it.
fn origin_restricted_by(
    read: &dyn KvRead,
    page: &PageRecord,
    closes: &dyn Fn(&PageRecord) -> Result<bool>,
) -> Result<bool> {
    let fm = &page.frontmatter;
    let source = page.source_id.as_str();
    let restricted = if page.page_type == "atom" {
        origin_where(read, source, text(fm, "source_slug").as_deref(), closes)?
    } else if page.page_type == "question"
        || (page.page_type == "concept" && text(fm, "synthesized_by").is_some())
    {
        let mut any = false;
        for input in concept_inputs(read, page)? {
            let origin = text(&input.frontmatter, "source_slug");
            if closes(&input)? || origin_where(read, &input.source_id, origin.as_deref(), closes)? {
                any = true;
                break;
            }
        }
        any
    } else if page.page_type == "event" && life_chronicle(page) {
        origin_where(read, source, chronicle_depth(page).as_deref(), closes)?
    } else {
        false
    };
    if restricted {
        return Ok(true);
    }
    for slug in declared_slugs(fm).unwrap_or_default() {
        if origin_where(read, source, Some(&slug), closes)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `frontmatter ->> 'captured_via' LIKE 'life-chronicle:%'`.
fn life_chronicle(page: &PageRecord) -> bool {
    text(&page.frontmatter, "captured_via").is_some_and(|v| v.starts_with("life-chronicle:"))
}

/// `frontmatter -> 'event' ->> 'depth'`.
pub(crate) fn chronicle_depth(page: &PageRecord) -> Option<String> {
    page.frontmatter
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("depth"))
        .and_then(jsonb_field_text)
}

/// `privacyPartSql`: the page's own fields, its derived origin and its declared lineage.
pub(crate) fn privacy_allows(
    read: &dyn KvRead,
    page: &PageRecord,
    honor_aliases: bool,
) -> Result<bool> {
    Ok(snapshot_allows(page, honor_aliases)
        && !derived_origin_private(read, page, honor_aliases)?
        && !declared_lineage_private(read, page)?)
}

/// `privateSnapshotFilterFragment`: `visibility` (an absent one is private on a derived page),
/// the `pinned_question` marker, and the privacy aliases of a page with no `visibility`.
fn snapshot_allows(page: &PageRecord, honor_aliases: bool) -> bool {
    snapshot_fields_allow(&page.page_type, &page.frontmatter, honor_aliases)
}

/// `privateSnapshotFilterFragment` over a row's type and frontmatter.
pub(crate) fn snapshot_fields_allow(
    page_type: &str,
    fm: &Map<String, Value>,
    honor_aliases: bool,
) -> bool {
    let visibility = text(fm, "visibility");
    let effective = visibility
        .as_deref()
        .unwrap_or(if derived_fields(page_type, fm) {
            "private"
        } else {
            "world"
        });
    effective != "private"
        && !fm.contains_key("pinned_question")
        && !(honor_aliases && visibility.is_none() && alias_private(fm))
}

/// `privacyAliasSql`: an alias value, trimmed of edge spaces and ASCII lower-cased, is private.
pub(crate) fn alias_private(frontmatter: &Map<String, Value>) -> bool {
    PRIVACY_ALIASES.iter().any(|(key, values)| {
        text(frontmatter, key).is_some_and(|v| {
            let v = v.trim_matches(EDGE_SPACE).to_ascii_lowercase();
            values.contains(&v.as_str())
        })
    })
}

/// `derivedOriginPrivateSql`: an atom whose origin page is private, a question or synthesized
/// concept with a private input, a Life Chronicle event whose origin is not visible.
fn derived_origin_private(
    read: &dyn KvRead,
    page: &PageRecord,
    honor_aliases: bool,
) -> Result<bool> {
    let source = page.source_id.as_str();
    if page.page_type == "atom" {
        return atom_origin_private(read, page);
    }
    if derived_page(page) {
        for input in concept_inputs(read, page)? {
            let visibility = text(&input.frontmatter, "visibility");
            let default = if input.page_type == "atom" {
                "private"
            } else {
                "world"
            };
            if visibility.as_deref().unwrap_or(default) == "private"
                || atom_origin_private(read, &input)?
            {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    if page.page_type == "event" && life_chronicle(page) {
        let Some(depth) = chronicle_depth(page) else {
            return Ok(true);
        };
        let visible = match read_page(read, source, &depth)? {
            Some(origin) => {
                snapshot_allows(&origin, honor_aliases) && !declared_lineage_private(read, &origin)?
            }
            None => false,
        };
        return Ok(!visible);
    }
    Ok(false)
}

/// The atom-origin probe (`src/core/persistence/atom-origin.ts`): a page explicitly private at
/// `source_slug`, at the slug its `rename` alias resolves to (`atomOriginSlugsSql`), or at a slug
/// `slug_rename_history` moved it to (`atomMovedOriginPrivateSql`, #8920).
fn atom_origin_private(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let source = page.source_id.as_str();
    let Some(slug) = text(&page.frontmatter, "source_slug") else {
        return Ok(false);
    };
    let mut slugs = vec![slug.clone()];
    if let Some(alias) = read_slug_alias(read, source, &slug)?
        && alias.notes.as_deref() == Some("rename")
    {
        slugs.push(alias.canonical_slug);
    }
    slugs.extend(renamed_to(read, source, &slug)?);
    any_page_where(read, source, &slugs, |p| Ok(explicitly_private(p)))
}

/// `declaredLineagePrivateSql`: a page named in `derived_from` is explicitly private.
fn declared_lineage_private(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    match declared_slugs(&page.frontmatter) {
        Some(slugs) => any_page_where(read, &page.source_id, &slugs, |p| Ok(explicitly_private(p))),
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;
    use crate::access_rules::{AccessRuleRecord, PendingCoverageRecord};
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;
    use serde_json::{Map, Value, json};

    fn readers(value: Value) -> Option<Vec<String>> {
        let mut frontmatter = Map::new();
        frontmatter.insert("readable_by".to_string(), value);
        access_readers(&frontmatter)
    }

    fn put(store: &Store, slug: &str) -> PageRecord {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let read = store.read().unwrap();
        read_page(&*read, "default", slug).unwrap().unwrap()
    }

    fn rule(id: &str, prefix: &str, covers_derived: bool) -> AccessRuleRecord {
        AccessRuleRecord {
            source_id: "default".into(),
            rule_id: id.into(),
            prefix: prefix.into(),
            readable_by: vec!["member:alice-example".into()],
            revision: 1,
            covers_derived,
            created_by: None,
        }
    }

    fn items(frontmatter: Value) -> Option<Vec<Option<String>>> {
        declared_items(frontmatter.as_object().unwrap())
    }

    /// The labelled walk reads `derived_from` as `jsonb_array_elements_text` does: a null item stays an item (it names no
    /// page, so the walk fails closed), one `.md` goes, and a value that is not a list or a string is no branch.
    #[test]
    fn declared_items_keep_a_null_item_and_strip_one_md() {
        let some = |s: &str| Some(s.to_string());
        assert_eq!(items(json!({})), None);
        assert_eq!(items(json!({"derived_from": null})), None);
        assert_eq!(items(json!({"derived_from": 5})), None);
        assert_eq!(items(json!({"derived_from": {"a": 1}})), None);
        assert_eq!(items(json!({"derived_from": []})), Some(vec![]));
        assert_eq!(
            items(json!({"derived_from": "a/b.md"})),
            Some(vec![some("a/b")])
        );
        assert_eq!(
            items(json!({"derived_from": "a/b.md.md"})),
            Some(vec![some("a/b.md")])
        );
        assert_eq!(items(json!({"derived_from": ".md"})), Some(vec![some("")]));
        assert_eq!(
            items(json!({"derived_from": ["a.md", null, "b", 7]})),
            Some(vec![some("a"), None, some("b"), some("7")])
        );
        // `declared_slugs`, the privacy walk's reader, drops the null: it must not be used for the labelled walk.
        assert_eq!(
            declared_slugs(json!({"derived_from": ["a.md", null]}).as_object().unwrap()),
            Some(vec!["a".to_string()])
        );
    }

    #[test]
    fn a_page_with_no_lineage_to_walk_is_plain() {
        let store = store();
        let base = put(&store, "notes/base");
        let plain = |page_type: &str, frontmatter: Value| {
            let mut page = base.clone();
            page.page_type = page_type.into();
            page.frontmatter = frontmatter.as_object().unwrap().clone();
            plain_page(&page)
        };
        assert!(plain("note", json!({})));
        assert!(plain("note", json!({"source_slug": "x"})));
        for kind in ["atom", "question", "concept", "event"] {
            assert!(!plain(kind, json!({})), "{kind}");
        }
        assert!(!plain("note", json!({"derived_from": null})));
    }

    #[test]
    fn folder_rules_and_pending_prefixes_hide_pages_from_every_served_caller() {
        let store = store();
        let open_page = put(&store, "notes/open");
        let private = put(&store, "private/diary");
        let raw = put(&store, "raw/log");
        let queued = put(&store, "queued/plan");
        store.put_access_policy_state("default").unwrap();
        store
            .put_access_rule(rule("private", "private/", true))
            .unwrap();
        store.put_access_rule(rule("raw", "raw/", false)).unwrap();
        store
            .put_access_pending_coverage(PendingCoverageRecord {
                source_id: "default".into(),
                prefix: "queued/".into(),
                reason: "pending".into(),
                revision: None,
                detail: None,
            })
            .unwrap();
        let read = store.read().unwrap();
        let identity = ["member:alice-example".to_string()];
        let allowed = |page: &PageRecord, open: bool, derived: bool| {
            readers_allowed(
                &*read,
                page,
                &identity,
                FolderAccess::default(),
                open,
                derived,
                false,
            )
            .unwrap()
        };
        assert!(allowed(&open_page, false, false) && allowed(&open_page, true, false));
        for open in [false, true] {
            assert!(
                !allowed(&private, open, false),
                "a rule's reader is not served its satisfaction"
            );
            assert!(!allowed(&raw, open, false));
        }
        assert!(!allowed(&queued, false, false));
        // A caller record's rendering reads only its own coverage: a prefix the store holds pending
        // but the record does not name hides nothing (`coverageSql` inside a record).
        let record = |coverage: &[FolderCoverage]| {
            readers_allowed(
                &*read,
                &queued,
                &identity,
                FolderAccess {
                    satisfied: &[],
                    coverage,
                    record: true,
                },
                false,
                false,
                false,
            )
            .unwrap()
        };
        assert!(record(&[]));
        assert!(!record(&[FolderCoverage {
            source_id: queued.source_id.clone(),
            prefix: String::new(),
        }]));
        // As a fact's origin a raw-only rule does not count; a derived-covering rule does.
        assert!(allowed(&raw, false, true));
        assert!(!allowed(&private, false, true));
        assert!(origin_closed(&*read, &private).unwrap());
        assert!(!origin_closed(&*read, &raw).unwrap());
        assert!(origin_closed(&*read, &queued).unwrap());
        assert!(!origin_closed(&*read, &open_page).unwrap());
    }

    #[test]
    fn a_page_stamped_with_a_removed_rule_stays_hidden_until_the_restamp() {
        use crate::access_policy::{AccessRuleChanges, AccessRuleInsert};
        let store = store();
        let stamped = put(&store, "scope/diary");
        let open_page = put(&store, "notes/open");
        store.put_access_policy_state("default").unwrap();
        let change = |insert: Vec<AccessRuleInsert>, remove: &[&str], revision: i64| {
            store
                .apply_access_rule_changes(
                    "default",
                    &AccessRuleChanges {
                        remove: remove.iter().map(|r| r.to_string()).collect(),
                        insert,
                        pending: Vec::new(),
                        revision,
                        actor: "local:test".into(),
                    },
                )
                .unwrap();
        };
        change(
            vec![AccessRuleInsert {
                rule_id: "scope".into(),
                prefix: "scope/".into(),
                readable_by: vec!["member:bob-example".into()],
                covers_derived: true,
            }],
            &[],
            1,
        );
        store.finish_access_restamp("default").unwrap();
        let identity = ["member:alice-example".to_string()];
        let judge = || {
            let read = store.read().unwrap();
            let rules = stamped_rules(&*read, &stamped).unwrap();
            let allowed = readers_allowed(
                &*read,
                &stamped,
                &identity,
                FolderAccess::default(),
                false,
                false,
                false,
            )
            .unwrap();
            let short = names_no_readers_or_rules(&*read, &stamped).unwrap();
            let closed = origin_closed(&*read, &stamped).unwrap();
            let open_rules = stamped_rules(&*read, &open_page).unwrap();
            (
                rules.into_iter().map(|r| r.rule_id).collect::<Vec<_>>(),
                allowed,
                short,
                closed,
                open_rules.is_empty(),
            )
        };
        // The live rule covers the page and the restamp kept its id: the live rule is the only one.
        assert_eq!(
            judge(),
            (vec!["scope".to_string()], false, false, true, true)
        );
        // The rule is removed and nothing restamped: the kept id names a rule that is gone, which
        // no caller satisfies and which closes the origin tests, as `folder_rule_ids` does in SQL.
        change(Vec::new(), &["scope"], 2);
        assert_eq!(
            judge(),
            (vec!["scope".to_string()], false, false, true, true)
        );
        // The restamp drops the kept id: the page is open again, and the open page was never held.
        store.finish_access_restamp("default").unwrap();
        assert_eq!(judge(), (Vec::new(), true, true, false, true));
    }

    #[test]
    fn a_reader_a_rule_names_is_served_the_folder_unless_its_record_covers_the_prefix() {
        let store = store();
        let private = put(&store, "private/diary");
        let raw = put(&store, "raw/log");
        store.put_access_policy_state("default").unwrap();
        store
            .put_access_rule(rule("private", "private/", true))
            .unwrap();
        store.put_access_rule(rule("raw", "raw/", false)).unwrap();
        let read = store.read().unwrap();
        let identity = ["member:alice-example".to_string()];
        let satisfied = ["default:private".to_string()];
        let coverage = [FolderCoverage {
            source_id: "default".into(),
            prefix: "private/".into(),
        }];
        let bad = [FolderCoverage {
            source_id: "default".into(),
            prefix: "../x".into(),
        }];
        let allowed = |page: &PageRecord, folders: FolderAccess<'_>, open: bool, derived: bool| {
            readers_allowed(&*read, page, &identity, folders, open, derived, false).unwrap()
        };
        let named = FolderAccess {
            satisfied: &satisfied,
            coverage: &[],
            record: false,
        };
        assert!(allowed(&private, named, false, false));
        assert!(
            !allowed(&raw, named, false, false),
            "an unsatisfied rule still closes its folder"
        );
        assert!(
            !allowed(&private, named, true, false),
            "the short form passes no stamped page"
        );
        assert!(allowed(&private, named, false, true));
        assert!(allowed(&raw, FolderAccess::default(), false, true));
        let covered = FolderAccess {
            satisfied: &satisfied,
            coverage: &coverage,
            record: false,
        };
        assert!(!allowed(&private, covered, false, false));
        let invalid = FolderAccess {
            satisfied: &satisfied,
            coverage: &bad,
            record: false,
        };
        assert!(!allowed(&private, invalid, false, false));
        let policy = PrivacyPolicy {
            identity: identity.to_vec(),
            satisfied_rule_ids: satisfied.to_vec(),
            owner_only: OwnerOnlyForm::Off,
            ..PrivacyPolicy::default()
        };
        assert!(!page_hidden(&*read, &private, &policy).unwrap());
        // A provenance page judged by the empty identity takes no satisfied rule (`satisfiedFor`).
        assert!(
            !member_access_allows(
                &*read,
                &private,
                &[],
                &policy,
                false,
                &super::OwnerOnlySources::read(&*read).unwrap()
            )
            .unwrap()
        );
    }

    #[test]
    fn access_readers_normalizes_as_gbrain_access_readers() {
        assert_eq!(access_readers(&Map::new()), None);
        assert_eq!(
            readers(json!([
                "bob-example",
                " Member:Alice-Example ",
                "group:team-a",
                "bob-example"
            ])),
            Some(vec![
                "group:team-a".to_string(),
                "member:alice-example".to_string(),
                "member:bob-example".to_string(),
            ])
        );
        assert_eq!(
            readers(json!("group:team-a")),
            Some(vec!["group:team-a".to_string()])
        );
        let nobody = Some(vec!["!nobody".to_string()]);
        for bad in [
            json!([]),
            json!([42]),
            json!(["alice-example", "not valid!"]),
            json!(null),
            json!({"a": 1}),
            json!(["group:"]),
            json!(["-alice"]),
            json!([format!("a{}", "b".repeat(64))]),
            Value::Array(vec![json!("a"); 257]),
        ] {
            assert_eq!(readers(bad), nobody);
        }
        assert_eq!(
            readers(json!([format!("a{}", "b".repeat(63))])).map(|r| r[0].len()),
            Some("member:".len() + 64)
        );
    }

    /// The owner-only contract reads an absent `ownerOnly` as `closed`. The folder-rule filter has
    /// no policy field: it reads the store's rules, and `member_access_allows` ANDs it with the
    /// owner-only test, so a policy with every defaulted field missing still hides a
    /// folder-restricted page, and an open owner-only form does not reopen it.
    #[test]
    fn a_policy_missing_its_defaulted_fields_still_hides_a_folder_restricted_page() {
        use super::{PrivacyPolicy, page_hidden};
        use crate::owner_only::OwnerOnlyForm;
        let store = store();
        let open_page = put(&store, "notes/open");
        let private = put(&store, "private/diary");
        store.put_access_policy_state("default").unwrap();
        store
            .put_access_rule(rule("private", "private/", true))
            .unwrap();
        let read = store.read().unwrap();
        let minimal: PrivacyPolicy =
            serde_json::from_str(r#"{"honorAliases":false,"entityPrivacy":false}"#).unwrap();
        assert_eq!(minimal.owner_only, OwnerOnlyForm::Closed);
        assert!(!minimal.open && minimal.identity.is_empty());
        assert!(page_hidden(&*read, &private, &minimal).unwrap());
        assert!(!page_hidden(&*read, &open_page, &minimal).unwrap());
        for form in ["off", "fn", "closed"] {
            let named: PrivacyPolicy = serde_json::from_str(&format!(
                r#"{{"honorAliases":false,"entityPrivacy":false,"identity":["member:alice-example"],"ownerOnly":"{form}","open":true}}"#
            ))
            .unwrap();
            assert!(
                page_hidden(&*read, &private, &named).unwrap(),
                "owner-only form {form} must not reopen a folder-restricted page"
            );
            assert!(!page_hidden(&*read, &open_page, &named).unwrap());
        }
    }

    /// The owner-only rules of `privateProvenanceFilterUnderPolicy` (its last term, `ownerOnlyFactAllowedSql`, and the
    /// provenance page judged by the member-access test): a fact held in an owner-only source, a fact whose provenance
    /// page is one, and (closed form) every fact while the brain holds an owner-only source are hidden.
    #[test]
    fn a_fact_of_an_owner_only_source_or_its_page_is_hidden() {
        let store = crate::test_support::store();
        let source = |id: &str, config: Value| {
            let input: crate::sources::SourceInput =
                serde_json::from_value(json!({ "id": id, "config": config })).unwrap();
            store.upsert_source(&input).unwrap();
        };
        let put_in = |source_id: &str, slug: &str| {
            let input: crate::pages::PageInput = serde_json::from_value(json!({
                "type": "note", "title": slug, "compiled_truth": "heron", "timeline": "", "frontmatter": {},
            }))
            .unwrap();
            let options = crate::pages::PutPageOptions {
                source_id: Some(source_id.to_string()),
                ..Default::default()
            };
            store.put_page(slug, &input, &options).unwrap();
        };
        let fact = |source_id: &str, slug: Option<&str>| FactRecord {
            source_id: source_id.to_string(),
            source_markdown_slug: slug.map(str::to_string),
            ..Default::default()
        };
        let hidden = |form: OwnerOnlyForm, row: &FactRecord| {
            let read = store.read().unwrap();
            let policy = PrivacyPolicy {
                honor_aliases: true,
                entity_privacy: true,
                owner_only: form,
                ..Default::default()
            };
            hidden_by_private_provenance(&*read, row, &policy).unwrap()
        };
        put_in("default", "notes/open");
        let open = fact("default", Some("notes/open"));
        let bare = fact("default", None);
        // With no owner-only source nothing is hidden, in either form.
        for form in [OwnerOnlyForm::Fn, OwnerOnlyForm::Closed] {
            assert!(!hidden(form, &open) && !hidden(form, &bare));
        }
        source("vault", json!({ "owner_only": true }));
        put_in("vault", "notes/vault");
        let in_vault = fact("vault", Some("notes/vault"));
        // A fact held in an owner-only source is hidden, with or without a provenance page.
        assert!(hidden(OwnerOnlyForm::Fn, &in_vault));
        assert!(hidden(OwnerOnlyForm::Fn, &fact("vault", None)));
        // A fact in an open source is not, whatever the other sources hold.
        assert!(!hidden(OwnerOnlyForm::Fn, &open) && !hidden(OwnerOnlyForm::Fn, &bare));
        // The closed form hides every fact while the brain holds an owner-only source.
        assert!(hidden(OwnerOnlyForm::Closed, &open) && hidden(OwnerOnlyForm::Closed, &bare));
        // Once the brain has held owner-only data (a mark), the closed form keeps hiding every fact after the source
        // stops being owner-only, as SQL's held flag does; the lineage form hides only the marked rows.
        store.delete_page("notes/vault", Some("vault")).unwrap();
        source("vault", json!({}));
        assert!(hidden(OwnerOnlyForm::Closed, &open) && hidden(OwnerOnlyForm::Closed, &bare));
        assert!(!hidden(OwnerOnlyForm::Fn, &open) && !hidden(OwnerOnlyForm::Fn, &in_vault));
    }

    /// `privateEntityFilterForCaller`'s keyed arm (GBRA-574): a bare name key is covered by the privacy
    /// of the page at `<dir>/<key>` in each name-key directory, as a slugged entity is by its own page.
    #[test]
    fn a_bare_entity_key_is_hidden_by_its_private_directory_page() {
        let store = crate::test_support::store();
        let put = |slug: &str, frontmatter: Value| {
            let input: crate::pages::PageInput = serde_json::from_value(json!({
                "type": "person", "title": slug, "compiled_truth": "body", "timeline": "", "frontmatter": frontmatter,
            }))
            .unwrap();
            store.put_page(slug, &input, &Default::default()).unwrap();
        };
        put("people/alice-example", json!({ "visibility": "private" }));
        put("companies/acme-example", json!({}));
        put("notes/alice-example", json!({ "visibility": "private" }));
        let fact = |entity: &str| FactRecord {
            source_id: "default".into(),
            entity_slug: Some(entity.into()),
            visibility: "world".into(),
            ..Default::default()
        };
        let hidden = |row: &FactRecord| {
            let read = store.read().unwrap();
            let policy = PrivacyPolicy {
                honor_aliases: true,
                entity_privacy: true,
                owner_only: OwnerOnlyForm::Fn,
                ..Default::default()
            };
            hidden_by_private_provenance(&*read, row, &policy).unwrap()
        };
        assert!(hidden(&fact("alice-example")));
        assert!(hidden(&fact("people/alice-example")));
        assert!(!hidden(&fact("acme-example")));
        // Only the name-key directories cover a bare key; a slugged key is judged by its own page only.
        assert!(!hidden(&fact("bob-example")));
        assert!(!hidden(&fact("notes/bob-example")));
    }

    /// `ownerReadPolicyFragment` and `readPolicyFragment` for an owner bound to `member:alice-example` (`owner_reads_page`):
    /// the owner's lineage test is identity-aware where the every-caller one closes any origin that names readers.
    #[test]
    fn an_owner_bound_to_a_member_reads_the_pages_its_identity_and_rules_open() {
        let store = store();
        let put_as = |slug: &str, page_type: &str, frontmatter: Value| {
            let input: PageInput = serde_json::from_value(json!({
                "type": page_type, "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
            }))
            .unwrap();
            store
                .put_page(slug, &input, &PutPageOptions::default())
                .unwrap();
        };
        put_as("notes/open", "note", json!({}));
        put_as(
            "notes/alice",
            "note",
            json!({ "readable_by": ["member:alice-example"] }),
        );
        put_as(
            "notes/bob",
            "note",
            json!({ "readable_by": ["member:bob-example"] }),
        );
        put_as("notes/private", "note", json!({ "visibility": "private" }));
        put_as(
            "notes/aliased",
            "note",
            json!({ "confidentiality": "secret" }),
        );
        for (slug, origin) in [
            ("atoms/of-alice", "notes/alice"),
            ("atoms/of-bob", "notes/bob"),
            ("atoms/of-open", "notes/open"),
        ] {
            put_as(
                slug,
                "atom",
                json!({ "visibility": "world", "source_slug": origin }),
            );
        }
        put_as(
            "notes/declares-alice",
            "note",
            json!({ "derived_from": ["notes/alice"] }),
        );
        put_as(
            "notes/declares-bob",
            "note",
            json!({ "derived_from": ["notes/bob.md"] }),
        );
        put_as("notes/filed", "note", json!({}));
        put_as("raw/log", "note", json!({}));
        put_as(
            "atoms/of-filed",
            "atom",
            json!({ "visibility": "world", "source_slug": "notes/filed" }),
        );
        put_as(
            "atoms/of-raw",
            "atom",
            json!({ "visibility": "world", "source_slug": "raw/log" }),
        );
        store.put_access_policy_state("default").unwrap();
        store
            .put_access_rule(rule("filed", "notes/filed", true))
            .unwrap();
        store.put_access_rule(rule("raw", "raw/", false)).unwrap();
        let policy = |satisfied: &[&str], honor_aliases: bool| PrivacyPolicy {
            honor_aliases,
            entity_privacy: true,
            identity: vec!["member:alice-example".into()],
            satisfied_rule_ids: satisfied.iter().map(|s| s.to_string()).collect(),
            owner_only: OwnerOnlyForm::Off,
            ..Default::default()
        };
        let reads = |slug: &str, policy: &PrivacyPolicy| {
            let read = store.read().unwrap();
            let page = read_page(&*read, "default", slug).unwrap().unwrap();
            owner_reads_page(&*read, &page, policy).unwrap()
        };
        let none = policy(&[], true);
        assert!(reads("notes/open", &none));
        // The page's own readers: named, or another member's.
        assert!(reads("notes/alice", &none));
        assert!(!reads("notes/bob", &none));
        assert!(!reads("notes/private", &none));
        // A privacy alias counts unless the operator turned `visibility.honor_aliases` off.
        assert!(!reads("notes/aliased", &none));
        assert!(reads("notes/aliased", &policy(&[], false)));
        // Lineage: the owner's test (`gbrain_access_origin_hidden_for`) closes an origin to a reader its readers do
        // not name, where the every-caller test (`gbrain_access_origin_restricted`) closes any origin that names readers.
        // The member read rule that follows keeps the every-caller test, so a derivative of a page that names readers
        // is not reached by any owner; the owner's own test stands alone when it is judged by itself.
        let identity = ["member:alice-example".to_string()];
        let lineage = |slug: &str, satisfied: &[&str]| {
            let satisfied: Vec<String> = satisfied.iter().map(|s| s.to_string()).collect();
            let read = store.read().unwrap();
            let page = read_page(&*read, "default", slug).unwrap().unwrap();
            let folders = FolderAccess {
                satisfied: &satisfied,
                coverage: &[],
                record: false,
            };
            let by = |owner_read| {
                readers_allowed(&*read, &page, &identity, folders, false, false, owner_read)
                    .unwrap()
            };
            (by(true), by(false))
        };
        assert_eq!(lineage("atoms/of-open", &[]), (true, true));
        assert_eq!(lineage("atoms/of-alice", &[]), (true, false));
        assert_eq!(lineage("atoms/of-bob", &[]), (false, false));
        assert_eq!(lineage("notes/declares-alice", &[]), (true, false));
        assert_eq!(lineage("notes/declares-bob", &[]), (false, false));
        assert_eq!(lineage("atoms/of-filed", &[]), (false, false));
        assert_eq!(lineage("atoms/of-filed", &["default:filed"]), (true, false));
        assert_eq!(lineage("atoms/of-raw", &[]), (true, true));
        assert!(reads("atoms/of-open", &none));
        assert!(!reads("atoms/of-alice", &none));
        assert!(!reads("atoms/of-bob", &none));
        assert!(!reads("notes/declares-alice", &none));
        assert!(!reads("notes/declares-bob", &none));
        // A folder rule keeps its page to a reader that satisfies it, and a rule that covers derived pages
        // keeps its lineage too; a raw-only rule keeps the page but not what derives from it.
        assert!(!reads("notes/filed", &none));
        assert!(reads("notes/filed", &policy(&["default:filed"], true)));
        assert!(!reads("notes/filed", &policy(&["default:other"], true)));
        assert!(!reads("atoms/of-filed", &none));
        // (the member read rule's every-caller lineage still closes it to the owner that satisfies the rule)
        assert!(!reads("atoms/of-filed", &policy(&["default:filed"], true)));
        assert!(!reads("raw/log", &none));
        assert!(reads("atoms/of-raw", &none));
        assert!(reads("raw/log", &policy(&["default:raw"], true)));
        // A pending prefix reads as nobody for the page and for its lineage.
        store
            .put_access_pending_coverage(PendingCoverageRecord {
                source_id: "default".into(),
                prefix: "notes/open".into(),
                reason: "pending".into(),
                revision: None,
                detail: None,
            })
            .unwrap();
        assert!(!reads("notes/open", &none));
        assert!(!reads("atoms/of-open", &none));
        // Inside a caller record the record's coverage is the whole pending test (`coverageSql`), for both rules: a
        // prefix the store holds pending that the record does not name hides the page itself, but not its lineage,
        // which `gbrain_access_pending_covers` reads live.
        let record = |coverage: &[(&str, &str)]| PrivacyPolicy {
            caller_record: true,
            folder_coverage: coverage
                .iter()
                .map(|(source_id, prefix)| FolderCoverage {
                    source_id: source_id.to_string(),
                    prefix: prefix.to_string(),
                })
                .collect(),
            ..policy(&[], true)
        };
        assert!(reads("notes/open", &record(&[])));
        assert!(!reads("atoms/of-open", &record(&[])));
        assert!(!reads("notes/open", &record(&[("default", "notes/")])));
        assert!(reads("notes/alice", &record(&[("default", "other/")])));
        assert!(!reads("notes/alice", &record(&[("default", "")])));
    }

    /// `owner_reads_page` ends with the member-access test of `readPolicyFragment` in the policy's form: the short form
    /// (`open`) fails a page that names readers whatever the identity, and the owner-only forms hide an owner-only page.
    #[test]
    fn the_member_read_rule_of_an_owner_follows_the_policys_form() {
        let store = store();
        let put_as = |slug: &str, frontmatter: Value| {
            let input: PageInput = serde_json::from_value(json!({
                "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
            }))
            .unwrap();
            store
                .put_page(slug, &input, &PutPageOptions::default())
                .unwrap();
        };
        put_as(
            "notes/alice",
            json!({ "readable_by": ["member:alice-example"] }),
        );
        put_as("notes/open", json!({}));
        let policy = |open: bool, owner_only: OwnerOnlyForm| PrivacyPolicy {
            honor_aliases: true,
            entity_privacy: true,
            identity: vec!["member:alice-example".into()],
            owner_only,
            open,
            ..Default::default()
        };
        let reads = |slug: &str, policy: &PrivacyPolicy| {
            let read = store.read().unwrap();
            let page = read_page(&*read, "default", slug).unwrap().unwrap();
            owner_reads_page(&*read, &page, policy).unwrap()
        };
        assert!(reads("notes/alice", &policy(false, OwnerOnlyForm::Off)));
        assert!(!reads("notes/alice", &policy(true, OwnerOnlyForm::Off)));
        assert!(reads("notes/open", &policy(true, OwnerOnlyForm::Off)));
        // Every page is hidden in the closed form while the brain holds an owner-only source.
        store
            .upsert_source(&crate::sources::SourceInput {
                id: "vault".into(),
                name: Some("vault".into()),
                config: Some(serde_json::from_value(json!({ "owner_only": true })).unwrap()),
                ..Default::default()
            })
            .unwrap();
        assert!(reads("notes/open", &policy(false, OwnerOnlyForm::Fn)));
        assert!(!reads("notes/open", &policy(false, OwnerOnlyForm::Closed)));
        assert!(reads("notes/open", &policy(false, OwnerOnlyForm::Off)));
    }

    /// `privateProvenanceFilterUnderPolicy` for the owner's lineage read (`owner_lineage`): a provenance page that is not
    /// a member page is judged by the owner's identity under the owner read rule, so its own `readable_by` page and a
    /// page derived from it are served while a page derived from another member's origin stays hidden; member pages keep
    /// the ordinary test. Without `owner_lineage` the non-member page is judged with no identity.
    #[test]
    fn the_owner_lineage_policy_judges_a_non_member_provenance_page_as_the_owner() {
        let store = crate::test_support::store();
        let put = |slug: &str, frontmatter: Value| {
            let input: crate::pages::PageInput = serde_json::from_value(json!({
                "type": "note", "title": slug, "compiled_truth": "body", "timeline": "", "frontmatter": frontmatter,
            }))
            .unwrap();
            store.put_page(slug, &input, &Default::default()).unwrap();
        };
        put("notes/open", json!({}));
        put(
            "notes/owner-origin",
            json!({ "readable_by": ["member:owner-example"] }),
        );
        put(
            "notes/bob-origin",
            json!({ "readable_by": ["member:bob-example"] }),
        );
        put(
            "notes/from-owner",
            json!({ "derived_from": ["notes/owner-origin"] }),
        );
        put(
            "notes/from-bob",
            json!({ "derived_from": ["notes/bob-origin.md"] }),
        );
        put(
            "memory/members/bob-example",
            json!({ "readable_by": ["member:bob-example"] }),
        );
        let fact = |slug: &str| FactRecord {
            source_id: "default".into(),
            entity_slug: Some("people/subject-example".into()),
            source_markdown_slug: Some(slug.into()),
            visibility: "world".into(),
            ..Default::default()
        };
        let hidden = |slug: &str, owner_lineage: bool| {
            let read = store.read().unwrap();
            let policy = PrivacyPolicy {
                identity: vec!["member:owner-example".into()],
                member_page: Some("memory/members/owner-example".into()),
                provenance_privacy_off: true,
                owner_read: true,
                owner_lineage,
                owner_only: OwnerOnlyForm::Off,
                ..Default::default()
            };
            hidden_by_provenance_page(&*read, &fact(slug), &policy, true).unwrap()
        };
        assert!(!hidden("notes/open", true));
        assert!(!hidden("notes/owner-origin", true));
        assert!(!hidden("notes/from-owner", true));
        assert!(hidden("notes/bob-origin", true));
        assert!(hidden("notes/from-bob", true));
        assert!(hidden("memory/members/bob-example", true));
        // The form before the lineage flag judged the owner's own origin with no identity: it hid it.
        assert!(hidden("notes/owner-origin", false));
        assert!(!hidden("notes/open", false));
    }
}
