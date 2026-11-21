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
//! The store keeps no access rules or pending coverage, so the parts of the SQL that read those
//! tables take their empty-table values: a page names readers only through a `readable_by` key
//! and no folder rule covers a page. Slug aliases and rename history come from `aliases.rs`
//! ([`read_slug_alias`], [`renamed_to`]), so an origin a rename moved is followed as PGLite
//! follows it, for the fact rules and for `page_hidden` alike.

use super::FactRecord;
use crate::Result;
use crate::access_flag::RESTRICTIONS_PRESENT_KEY;
use crate::aliases::{read_slug_alias, renamed_to};
use crate::keys;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::owner_only::{OwnerOnlyForm, any_owner_only, fact_owner_only, page_owner_only};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::sync::OnceLock;

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
    /// Whether the brain holds an owner-only source, read once for the one read this policy came
    /// with (the `closed` form asks it for every row).
    #[serde(skip)]
    #[doc(hidden)]
    pub owner_only_any: OnceLock<bool>,
    /// The caller renders the short member-access form (`CallerAccess.restricted` false:
    /// `page_readers IS NULL AND folder_rule_ids IS NULL`), so a page that names readers fails
    /// whatever the identity. The store's own flag (`access.restrictions_present`) decides the
    /// rest: unset, nothing else applies, as the short form says; set (the caller's flag read was
    /// stale), the full form's origin walk applies too. See [`readers_allowed`]. The remote floor
    /// (`provenance_only`) is the exception: it judges the short form alone, as the SQL does.
    #[serde(default)]
    pub open: bool,
    /// The owner read rule (`ownerReadPolicyFragment`, the opt-in off): a derived page's origins are judged by
    /// `identity` (`gbrain_access_origin_hidden_for`: an origin that names readers closes the page only when none
    /// of them is a principal of `identity`) instead of by any reader list (`gbrain_access_origin_restricted`).
    /// The store keeps no folder rule, pending coverage or audience member, so those parts of the rule pass.
    #[serde(default)]
    pub owner_read: bool,
}

impl PrivacyPolicy {
    /// `ownerOnlyPageSql(alias, form)` under this policy's form.
    fn page_owner_only(&self, read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
        match self.owner_only {
            OwnerOnlyForm::Closed => self.any_owner_only(read),
            form => page_owner_only(read, page, form),
        }
    }

    /// `ownerOnlyFactSql(alias, form)` under this policy's form.
    fn fact_owner_only(&self, read: &dyn KvRead, source_id: &str) -> Result<bool> {
        match self.owner_only {
            OwnerOnlyForm::Closed => self.any_owner_only(read),
            form => fact_owner_only(read, source_id, form),
        }
    }

    fn any_owner_only(&self, read: &dyn KvRead) -> Result<bool> {
        if let Some(any) = self.owner_only_any.get() {
            return Ok(*any);
        }
        let any = any_owner_only(read)?;
        Ok(*self.owner_only_any.get_or_init(|| any))
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
const EDGE_SPACE: &[char] = &[
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
    if policy.fact_owner_only(read, &row.source_id)? {
        return Ok(true);
    }
    // The remote floor (`provenance_only`) of a caller that renders the short member-access form
    // (`open`) has no origin test, whatever the store's restriction flag says, as the forget floor.
    let restricted = !(policy.provenance_only && policy.open);
    if hidden_by_provenance_page(read, row, policy, restricted)? {
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
        if page_hidden(read, &page, policy)? {
            return Ok(true);
        }
    }
    // `sharedHeldRuledSql` hides a held fact only under a folder rule or pending coverage.
    Ok(false)
}

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
    let Some(slug) = &row.source_markdown_slug else {
        return Ok(false);
    };
    let Some(page) = read_page(read, &row.source_id, slug)? else {
        return Ok(false);
    };
    let access = if restricted {
        member_access_allows(read, &page, provenance_identity(policy, slug), policy)?
    } else {
        !names_readers(&page) && !policy.page_owner_only(read, &page)?
    };
    Ok(!(access && privacy_allows(read, &page, policy.honor_aliases)?))
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

/// Whether the page policy `privatePagesFilterForCaller(p)` hides `page`: the member-access part
/// for the policy's identity, then the privacy part unless `entity_privacy` is false, which a page
/// of a private-readable source passes unless it is a pinned question. It is the test the entity
/// gate puts on an entity page.
pub(crate) fn page_hidden(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let allowed = member_access_allows(read, page, &policy.identity, policy)?
        && (!policy.entity_privacy
            || private_source_open(page, policy)
            || privacy_allows(read, page, policy.honor_aliases)?);
    Ok(!allowed)
}

/// The member-access part (`accessAllowedSql`): the page's readers allow `identity`, and the page
/// is not owner-only (`ownerOnlyAllowedSql`, in the policy's form).
fn member_access_allows(
    read: &dyn KvRead,
    page: &PageRecord,
    identity: &[String],
    policy: &PrivacyPolicy,
) -> Result<bool> {
    Ok(
        readers_allowed(read, page, identity, policy.open, policy.owner_read)?
            && !policy.page_owner_only(read, page)?,
    )
}

/// `orPrivateReadableSource`: the page's source is in the private-readable grant and the page
/// does not carry `pinned_question`.
fn private_source_open(page: &PageRecord, policy: &PrivacyPolicy) -> bool {
    policy.private_readable_sources.contains(&page.source_id)
        && !page.frontmatter.contains_key("pinned_question")
}

/// Whether the no-caller policy hides a page version (`callerReadersAllowedSql(pv, 'snapshot') AND
/// privacyForCaller(p, privateSnapshotFilterFragment(pv))`): the version names readers, or, with
/// `entity_privacy`, its own fields are private. Only the version's type and frontmatter count.
pub(crate) fn version_hidden(
    page_type: &str,
    fm: &Map<String, Value>,
    policy: &PrivacyPolicy,
) -> bool {
    fm.contains_key("readable_by")
        || (policy.entity_privacy && !snapshot_fields_allow(page_type, fm, policy.honor_aliases))
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
) -> bool {
    let readers_allowed = !fm.contains_key("readable_by")
        || access_readers(fm)
            .is_some_and(|readers| readers.iter().any(|r| policy.identity.contains(r)));
    !readers_allowed
        || (policy.entity_privacy
            && (fm.contains_key("pinned_question")
                || !(private_source_open(page, policy)
                    || snapshot_fields_allow(page_type, fm, policy.honor_aliases))))
}

/// `holdingSlugSql`: `memory/unattributed`, or a slug ending in `/memory/unattributed`.
pub(super) fn holding_slug(slug: &str) -> bool {
    slug == "memory/unattributed" || slug.ends_with("/memory/unattributed")
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
fn concept_inputs(read: &dyn KvRead, page: &PageRecord) -> Result<Vec<PageRecord>> {
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
fn declared_slugs(frontmatter: &Map<String, Value>) -> Option<Vec<String>> {
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
    test: impl Fn(&PageRecord) -> bool,
) -> Result<bool> {
    let Some(slug) = slug else {
        return Ok(false);
    };
    Ok(read_page(read, source_id, slug)?.is_some_and(|p| test(&p)))
}

/// Any page of `slugs` in `source_id` that passes `test`.
fn any_page_where(
    read: &dyn KvRead,
    source_id: &str,
    slugs: &[String],
    test: impl Fn(&PageRecord) -> bool,
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
    test: impl Fn(&PageRecord) -> bool,
) -> Result<bool> {
    let Some(slug) = slug else {
        return Ok(false);
    };
    any_page_where(read, source_id, &origin_slugs(read, source_id, slug)?, test)
}

/// A page that names readers: `frontmatter ? 'readable_by'` (no folder rule or pending coverage).
fn names_readers(page: &PageRecord) -> bool {
    page.frontmatter.contains_key("readable_by")
}

/// `frontmatter ->> 'visibility' = 'private'`.
fn explicitly_private(page: &PageRecord) -> bool {
    text(&page.frontmatter, "visibility").as_deref() == Some("private")
}

/// `NOBODY`: the readers of a `readable_by` value that is present but malformed.
const NOBODY: &str = "!nobody";

/// `ACCESS_ID_RE`, `^[a-z0-9][a-z0-9._-]{0,63}$`.
fn access_id(id: &str) -> bool {
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
/// that name one of its principals (`readersAllowedSql`), and no origin that names readers. With
/// `open` (the short form) a page that names readers fails for any identity, and the origin walk
/// runs only when the store's flag is set: unset, no stored page names readers. With `owner_read`
/// (the owner read rule) an origin closes the page only when its readers leave `identity` out.
fn readers_allowed(
    read: &dyn KvRead,
    page: &PageRecord,
    identity: &[String],
    open: bool,
    owner_read: bool,
) -> Result<bool> {
    if open && (names_readers(page) || !restrictions_present(read)?) {
        return Ok(!names_readers(page));
    }
    if names_readers(page) && !readers_name(page, identity) {
        return Ok(false);
    }
    let plain = !matches!(
        page.page_type.as_str(),
        "atom" | "question" | "concept" | "event"
    ) && !page.frontmatter.contains_key("derived_from");
    if plain {
        return Ok(true);
    }
    let closed = if owner_read {
        origin_closed(read, page, &|o| {
            names_readers(o) && !readers_name(o, identity)
        })?
    } else {
        origin_closed(read, page, &names_readers)?
    };
    Ok(!closed)
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
/// `closes` = [`names_readers`]) and of `gbrain_access_origin_hidden_for(...)` (an owner read, `closes` = the
/// origin names readers none of which is the reader): whether an origin of the page closes it.
fn origin_closed(
    read: &dyn KvRead,
    page: &PageRecord,
    closes: &dyn Fn(&PageRecord) -> bool,
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
            if closes(&input) || origin_where(read, &input.source_id, origin.as_deref(), closes)? {
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
fn chronicle_depth(page: &PageRecord) -> Option<String> {
    page.frontmatter
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("depth"))
        .and_then(jsonb_field_text)
}

/// `privacyPartSql`: the page's own fields, its derived origin and its declared lineage.
fn privacy_allows(read: &dyn KvRead, page: &PageRecord, honor_aliases: bool) -> Result<bool> {
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
fn snapshot_fields_allow(page_type: &str, fm: &Map<String, Value>, honor_aliases: bool) -> bool {
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
fn alias_private(frontmatter: &Map<String, Value>) -> bool {
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
    any_page_where(read, source, &slugs, explicitly_private)
}

/// `declaredLineagePrivateSql`: a page named in `derived_from` is explicitly private.
fn declared_lineage_private(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    match declared_slugs(&page.frontmatter) {
        Some(slugs) => any_page_where(read, &page.source_id, &slugs, explicitly_private),
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::access_readers;
    use serde_json::{Map, Value, json};

    fn readers(value: Value) -> Option<Vec<String>> {
        let mut frontmatter = Map::new();
        frontmatter.insert("readable_by".to_string(), value);
        access_readers(&frontmatter)
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
}
