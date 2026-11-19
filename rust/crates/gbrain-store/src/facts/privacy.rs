//! The private-provenance policy of a fact read: `privateProvenanceFilterUnderPolicy('facts')`
//! (src/core/search/private-visibility.ts), which PGLite adds to a read that passes
//! `excludePrivate`. rust/docs/store/facts.md names the file and line of every rule below.
//!
//! The policy is the one PGLite renders with no caller record: the empty identity, no folder
//! rule satisfied, no lineage read. The TypeScript member refuses any other caller before it
//! reads. Two process settings change that rendering, and the member passes both:
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
//! is while the brain holds an owner-only source (`OwnerOnly::Closed`). `owner_only_marks` (`owner_only_marks.rs`) keeps a
//! page hidden after its owner-only input is deleted for good, as SQL's delete trigger does. The store keeps no
//! `derivation_inputs`, so a page derived from an owner-only row by that table alone is not hidden here.
//!
//! The owner-only sources are read once per read, on the first page it judges ([`OwnerOnlyCache`]): the page reads
//! (`searchVector`, the link, alias, salience and page-read members) each keep one, so a read of many pages does not
//! scan the sources for each. A fact read ends with the same rule (`ownerOnlyFactAllowedSql`): a fact held in an
//! owner-only source is hidden, or every fact is under the closed form, and the provenance page is judged by the
//! owner-only rule as a page ([`hidden_by_private_provenance`]).

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
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyPolicy {
    /// `honorAliases()`: a page with no `visibility` and a private `access` or
    /// `confidentiality` value is private.
    pub honor_aliases: bool,
    /// `privacyForCaller`: the entity and holding pages are judged by the privacy part too.
    pub entity_privacy: bool,
    /// The owner-only form the baseline rendered (`src/core/access/owner-only.ts`): see [`OwnerOnly`].
    pub owner_only: OwnerOnly,
}

/// The owner-only part of `accessAllowedSql` for the no-caller baseline (`ownerOnlyPageSql`). It is part of the
/// member-access test, so `entity_privacy` does not switch it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerOnly {
    /// `gbrain_owner_only_lineage('pages', id)` behind its guard (schema v320 and above): a page held in an owner-only
    /// source is hidden, and so is a concept or question with a `concept-provenance` input page in one, and a page
    /// `owner_only_marks` names (`owner_only_marks.rs`). The rows `derivation_inputs` names are not here: this store
    /// keeps no such table.
    Lineage,
    /// `ANY_OWNER_ONLY_SQL` (a brain below v320, or a call outside an engine scope): any owner-only source in the
    /// brain hides every page.
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
    /// every fact is while the brain holds an owner-only source (the closed form). The rows `derivation_inputs` and
    /// `owner_only_marks` name are not here: this store keeps no `derivation_inputs`, and its marks name pages only.
    fn fact_hidden(&self, form: OwnerOnly, source_id: &str) -> bool {
        !self.ids.is_empty() && (form == OwnerOnly::Closed || self.holds(source_id))
    }
}

/// The owner-only sources of one read, found on the first page the read judges and kept for the rest (a read that
/// judges no page, or runs with no policy, never looks at the sources).
#[derive(Default)]
pub(crate) struct OwnerOnlyCache(Option<OwnerOnlySources>);

impl OwnerOnlyCache {
    /// [`page_hidden`] with the sources of this read.
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
        page_hidden(read, page, policy, sources)
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
    owner_only: &OwnerOnlySources,
) -> Result<bool> {
    // `ownerOnlyFactAllowedSql`: the fact itself is held in an owner-only source.
    if owner_only.fact_hidden(policy.owner_only, &row.source_id) {
        return Ok(true);
    }
    // The provenance page is judged by `readPolicyFragment('pp', ..)`: the member-access part (which holds the
    // owner-only rule) and the privacy part.
    if let Some(slug) = &row.source_markdown_slug
        && let Some(page) = read_page(read, &row.source_id, slug)?
        && !(!owner_only_hidden(read, &page, policy.owner_only, owner_only)?
            && readers_allowed(read, &page)?
            && privacy_allows(read, &page, policy.honor_aliases)?)
    {
        return Ok(true);
    }
    let held = match (&row.entity_slug, &row.source_markdown_slug) {
        (Some(_), Some(slug)) if holding_slug(slug) => Some(slug),
        _ => None,
    };
    for slug in [row.entity_slug.as_ref(), held].into_iter().flatten() {
        let Some(page) = read_page(read, &row.source_id, slug)? else {
            continue;
        };
        if page_hidden(read, &page, policy, owner_only)? {
            return Ok(true);
        }
    }
    // GBRA-574: a bare name key (no `/`) reads as the page later written at `<dir>/<key>`, so each
    // such page's privacy covers it.
    if let Some(key) = row.entity_slug.as_deref().filter(|e| !e.contains('/')) {
        for dir in NAME_KEY_PAGE_DIRS {
            let Some(page) = read_page(read, &row.source_id, &format!("{dir}/{key}"))? else {
                continue;
            };
            if page_hidden(read, &page, policy, owner_only)? {
                return Ok(true);
            }
        }
    }
    // `sharedHeldRuledSql` hides a held fact only under a folder rule or pending coverage.
    Ok(false)
}

/// `NAME_KEY_PAGE_DIRS` (`src/core/entities/basename-dirs.ts`): the directories whose page at
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

/// Whether the page policy `privatePagesFilterForCaller(p)` hides `page`: the member-access part
/// for the empty identity (named readers, origin readers, the owner-only rule), then the privacy part
/// unless `entity_privacy` is false. It is the test the entity gate puts on an entity page.
pub(crate) fn page_hidden(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
    owner_only: &OwnerOnlySources,
) -> Result<bool> {
    let allowed = !owner_only_hidden(read, page, policy.owner_only, owner_only)?
        && readers_allowed(read, page)?
        && (!policy.entity_privacy || privacy_allows(read, page, policy.honor_aliases)?);
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
        // `ANY_OWNER_ONLY_SQL` reads sources only: no mark is read in a brain below v320.
        return Ok(!sources.ids.is_empty());
    }
    Ok(sources.guarded() && sources.lineage_strict(read, page)?)
}

/// `frontmatter ->> key`.
fn text(frontmatter: &Map<String, Value>, key: &str) -> Option<String> {
    frontmatter.get(key).and_then(jsonb_field_text)
}

/// `derivedPageSql`: an atom, a question, or a concept with `synthesized_by`.
fn derived_page(page: &PageRecord) -> bool {
    matches!(page.page_type.as_str(), "atom" | "question")
        || (page.page_type == "concept" && text(&page.frontmatter, "synthesized_by").is_some())
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

/// The member-access part for the empty identity (`accessAllowedSql`): no readers of its own,
/// and no origin that names readers.
fn readers_allowed(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    if names_readers(page) {
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
    let fm = &page.frontmatter;
    let visibility = text(fm, "visibility");
    let effective = visibility.as_deref().unwrap_or(if derived_page(page) {
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
    use serde_json::{Value, json};

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
            let sources = OwnerOnlySources::read(&*read).unwrap();
            let policy = PrivacyPolicy {
                honor_aliases: true,
                entity_privacy: true,
                owner_only: form,
            };
            hidden_by_private_provenance(&*read, row, &policy, &sources).unwrap()
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
            let sources = OwnerOnlySources::read(&*read).unwrap();
            let policy = PrivacyPolicy {
                honor_aliases: true,
                entity_privacy: true,
                owner_only: OwnerOnly::Lineage,
            };
            hidden_by_private_provenance(&*read, row, &policy, &sources).unwrap()
        };
        assert!(hidden(&fact("alice-example")));
        assert!(hidden(&fact("people/alice-example")));
        assert!(!hidden(&fact("acme-example")));
        // Only the name-key directories cover a bare key; a slugged key is judged by its own page only.
        assert!(!hidden(&fact("bob-example")));
        assert!(!hidden(&fact("notes/bob-example")));
    }
}
