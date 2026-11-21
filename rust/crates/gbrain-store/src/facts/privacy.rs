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
//! The store keeps no access rules or pending coverage, so the parts of the SQL that read those
//! tables take their empty-table values: a page names readers only through a `readable_by` key
//! and no folder rule covers a page. Slug aliases and rename history come from `aliases.rs`
//! ([`read_slug_alias`], [`renamed_to`]), so an origin a rename moved is followed as PGLite
//! follows it, for the fact rules and for `page_hidden` alike.
//!
//! The owner-only rule is the one part of the member-access test the store can answer for a page: a page of an
//! owner-only source, and a concept or question synthesized from one, is hidden (`OwnerOnly::Lineage`), or every page
//! is while the brain holds an owner-only source or has held owner-only data (`OwnerOnly::Closed`). `owner_only_marks`
//! (`owner_only_marks.rs`) keeps a page hidden after its owner-only input is deleted for good, as SQL's delete trigger
//! does. A fact read applies the rule to the provenance page, the entity and holding pages, and the fact row itself
//! (`ownerOnlyFactSql`: a fact of an owner-only source). The store keeps no `derivation_inputs`, so a row derived from an
//! owner-only row by that table alone is not hidden here.
//!
//! The owner-only sources are read once per read, on the first page it judges ([`OwnerOnlyCache`]): the page reads
//! (`searchVector`, the link, alias, salience and page-read members) each keep one, so a read of many pages does not
//! scan the sources for each.

use super::FactRecord;
use crate::Result;
use crate::aliases::{read_slug_alias, renamed_to};
use crate::kv::KvRead;
use crate::links::out_links;
use crate::owner_only_marks::{any_marked, is_marked};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::sources::all_sources;
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

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
    /// The owner-only form the baseline rendered (`src/core/access/owner-only.ts`): see [`OwnerOnly`].
    pub owner_only: OwnerOnly,
    /// `remoteProvenanceFloorSql('facts')`, the remote floor: only the provenance page is judged
    /// (`privateProvenanceFilterFragment`), with no entity or holding-page gate.
    #[serde(default)]
    pub provenance_only: bool,
}

/// The owner-only part of `accessAllowedSql` for the no-caller baseline (`ownerOnlyPageSql`). It is part of the
/// member-access test, so `entity_privacy` does not switch it off.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerOnly {
    /// `gbrain_owner_only_lineage('pages', id)` behind its guard (schema v320 and above), or its v328 form with the login's
    /// read mode, which is always the exact lineage here (the store has no logins whose reads row security narrows): a page held in an owner-only
    /// source is hidden, and so is a concept or question with a `concept-provenance` input page in one, and a page
    /// `owner_only_marks` names (`owner_only_marks.rs`). The rows `derivation_inputs` names are not here: this store
    /// keeps no such table.
    #[default]
    Lineage,
    /// The closed form (a brain below v320, or a call outside an engine scope): any owner-only source in the brain, or
    /// SQL's held flag (the brain has held owner-only data), hides every page. The store's held flag is a mark
    /// (`any_marked`), as for the lineage guard.
    Closed,
}

/// The ids of the owner-only sources (`isOwnerOnlySourceConfig`: kind `imessage`, or `owner_only` true), read once
/// per query and passed to [`page_hidden`].
pub(crate) struct OwnerOnlySources {
    ids: HashSet<String>,
    /// A row was marked owner-only when its origin was deleted (`owner_only_marks`), so the guard stays on.
    marked: bool,
}

impl OwnerOnlySources {
    pub(crate) fn read(read: &dyn KvRead) -> Result<Self> {
        let mut ids = HashSet::new();
        for source in all_sources(read)? {
            // `config ->> 'kind' IN ('imessage') OR config ->> 'owner_only' = 'true'`.
            if text(&source.config, "kind").as_deref() == Some("imessage")
                || text(&source.config, "owner_only").as_deref() == Some("true")
            {
                ids.insert(source.id);
            }
        }
        Ok(Self {
            ids,
            marked: any_marked(read)?,
        })
    }

    fn holds(&self, source_id: &str) -> bool {
        self.ids.contains(source_id)
    }

    /// `gbrain_owner_only_lineage()`: the brain holds an owner-only source or a mark, so the per-row test runs at all.
    pub(crate) fn guarded(&self) -> bool {
        !self.ids.is_empty() || self.marked
    }

    /// `gbrain_owner_only_lineage_strict('pages', id)`: marked, held in an owner-only source, or a concept or question with an
    /// input page in one. The `derivation_inputs` walk has no table here.
    pub(crate) fn lineage_strict(&self, read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
        if is_marked(read, page.id)? || self.holds(&page.source_id) {
            return Ok(true);
        }
        if matches!(page.page_type.as_str(), "concept" | "question") {
            for input in concept_inputs(read, page)? {
                if self.holds(&input.source_id) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// `ownerOnlyFactSql(facts, form)` for the no-caller baseline: a fact held in an owner-only source is hidden, or
    /// every fact is while the brain holds an owner-only source or a mark (the closed form). The rows `derivation_inputs` and
    /// `owner_only_marks` name are not here: this store keeps no `derivation_inputs`, and its marks name pages only.
    fn fact_hidden(&self, form: OwnerOnly, source_id: &str) -> bool {
        match form {
            OwnerOnly::Closed => self.guarded(),
            OwnerOnly::Lineage => self.holds(source_id),
        }
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
const EDGE_SPACE: &[char] = &[
    ' ', '\t', '\n', '\u{0B}', '\u{0C}', '\r', '\u{A0}', '\u{1680}', '\u{2000}', '\u{2001}',
    '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}',
    '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
];

/// Whether the policy hides `row`: the fact is held in an owner-only source, its provenance page
/// (`source_markdown_slug`) fails the page policy, or its entity page or holding page fails the entity gate. A soft-deleted page still
/// counts, as its row stays in `pages`.
pub(crate) fn hidden_by_private_provenance(
    read: &dyn KvRead,
    row: &FactRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let owner_only = &OwnerOnlySources::read(read)?;
    // `ownerOnlyFactSql(facts, form)` for a caller that is not the owner: a fact of an owner-only
    // source (`Lineage`; the store marks no fact rows), or any fact while the brain holds an
    // owner-only source (`Closed`).
    if owner_only.fact_hidden(policy.owner_only, &row.source_id) {
        return Ok(true);
    }
    if let Some(slug) = &row.source_markdown_slug
        && let Some(page) = read_page(read, &row.source_id, slug)?
        && owner_only_hidden(read, &page, policy.owner_only, owner_only)?
    {
        return Ok(true);
    }
    if hidden_by_provenance_page(read, row, policy)? {
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
        if page_hidden_with(read, &page, policy, owner_only)? {
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
            if page_hidden_with(read, &page, policy, owner_only)? {
                return Ok(true);
            }
        }
    }
    // `sharedHeldRuledSql` hides a held fact only under a folder rule or pending coverage.
    Ok(false)
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
/// which judges no entity or holding page. A missing page hides nothing.
pub(crate) fn hidden_by_provenance_page(
    read: &dyn KvRead,
    row: &FactRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let Some(slug) = &row.source_markdown_slug else {
        return Ok(false);
    };
    let Some(page) = read_page(read, &row.source_id, slug)? else {
        return Ok(false);
    };
    let access = readers_allowed(read, &page, provenance_identity(policy, slug))?;
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
    let allowed = !owner_only_hidden(read, page, policy.owner_only, owner_only)?
        && readers_allowed(read, page, &policy.identity)?
        && (!policy.entity_privacy
            || private_source_open(page, policy)
            || privacy_allows(read, page, policy.honor_aliases)?);
    Ok(!allowed)
}

/// `holdingSlugSql`: `memory/unattributed`, or a slug ending in `/memory/unattributed`.
fn holding_slug(slug: &str) -> bool {
    slug == "memory/unattributed" || slug.ends_with("/memory/unattributed")
}

/// `ownerOnlyPageSql(p, form)` for the no-caller baseline (the caller is never the owner).
fn owner_only_hidden(
    read: &dyn KvRead,
    page: &PageRecord,
    form: OwnerOnly,
    sources: &OwnerOnlySources,
) -> Result<bool> {
    if form == OwnerOnly::Closed {
        // The closed form reads the sources and the held flag, which a mark stands for here.
        return Ok(sources.guarded());
    }
    Ok(sources.guarded() && sources.lineage_strict(read, page)?)
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
/// that name one of its principals (`readersAllowedSql`), and no origin that names readers.
fn readers_allowed(read: &dyn KvRead, page: &PageRecord, identity: &[String]) -> Result<bool> {
    if names_readers(page)
        && !access_readers(&page.frontmatter)
            .is_some_and(|readers| readers.iter().any(|r| identity.contains(r)))
    {
        return Ok(false);
    }
    let plain = !matches!(
        page.page_type.as_str(),
        "atom" | "question" | "concept" | "event"
    ) && !page.frontmatter.contains_key("derived_from");
    Ok(plain || !origin_restricted(read, page)?)
}

/// `gbrain_access_origin_restricted(id, source_id, type, frontmatter)`.
fn origin_restricted(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let fm = &page.frontmatter;
    let source = page.source_id.as_str();
    let restricted = if page.page_type == "atom" {
        origin_where(
            read,
            source,
            text(fm, "source_slug").as_deref(),
            names_readers,
        )?
    } else if page.page_type == "question"
        || (page.page_type == "concept" && text(fm, "synthesized_by").is_some())
    {
        let mut any = false;
        for input in concept_inputs(read, page)? {
            let origin = text(&input.frontmatter, "source_slug");
            if names_readers(&input)
                || origin_where(read, &input.source_id, origin.as_deref(), names_readers)?
            {
                any = true;
                break;
            }
        }
        any
    } else if page.page_type == "event" && life_chronicle(page) {
        origin_where(
            read,
            source,
            chronicle_depth(page).as_deref(),
            names_readers,
        )?
    } else {
        false
    };
    if restricted {
        return Ok(true);
    }
    for slug in declared_slugs(fm).unwrap_or_default() {
        if origin_where(read, source, Some(&slug), names_readers)? {
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
    use super::*;
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
        let hidden = |form: OwnerOnly, row: &FactRecord| {
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
        for form in [OwnerOnly::Lineage, OwnerOnly::Closed] {
            assert!(!hidden(form, &open) && !hidden(form, &bare));
        }
        source("vault", json!({ "owner_only": true }));
        put_in("vault", "notes/vault");
        let in_vault = fact("vault", Some("notes/vault"));
        // A fact held in an owner-only source is hidden, with or without a provenance page.
        assert!(hidden(OwnerOnly::Lineage, &in_vault));
        assert!(hidden(OwnerOnly::Lineage, &fact("vault", None)));
        // A fact in an open source is not, whatever the other sources hold.
        assert!(!hidden(OwnerOnly::Lineage, &open) && !hidden(OwnerOnly::Lineage, &bare));
        // The closed form hides every fact while the brain holds an owner-only source.
        assert!(hidden(OwnerOnly::Closed, &open) && hidden(OwnerOnly::Closed, &bare));
        // Once the brain has held owner-only data (a mark), the closed form keeps hiding every fact after the source
        // stops being owner-only, as SQL's held flag does; the lineage form hides only the marked rows.
        store.delete_page("notes/vault", Some("vault")).unwrap();
        source("vault", json!({}));
        assert!(hidden(OwnerOnly::Closed, &open) && hidden(OwnerOnly::Closed, &bare));
        assert!(!hidden(OwnerOnly::Lineage, &open) && !hidden(OwnerOnly::Lineage, &in_vault));
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
                owner_only: OwnerOnly::Lineage,
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
}
