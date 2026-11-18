//! The page-privacy policy of a keyword read: `privatePagesFilterForCaller('p')`
//! (src/core/search/private-visibility.ts), which `buildVisibilityClause` adds to a search that passes
//! `excludePrivate`. rust/docs/store/keyword.md names the rules it applies.
//!
//! The policy is the one PGLite renders with no caller record: the empty identity, no folder rule
//! satisfied, no lineage read. The TypeScript member (`private-provenance.ts`) refuses any other caller
//! before it reads. Two process settings change that rendering, and the member passes both:
//! `honor_aliases` (`visibility.honor_aliases`) and `entity_privacy` (false when an operator relaxed
//! remote privacy, which drops the privacy part of the page policy only).
//!
//! The store keeps no access rules or pending coverage, so the parts of the SQL that read those tables
//! take their empty-table values: a page names readers only through a `readable_by` key and no folder
//! rule covers a page. It keeps no slug aliases or rename history either (the aliases family is not
//! served yet), so those lookups are empty too and an origin reference names only its own slug. When
//! the aliases family lands, `origin_slugs` and `atom_origin_private` read them as
//! `gbrain_access_origin_restricted` and the #8920 atom-origin probe do.

use crate::Result;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The policy settings the TypeScript member read from the rendered SQL.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyPolicy {
    /// `honorAliases()`: a page with no `visibility` and a private `access` or
    /// `confidentiality` value is private.
    pub honor_aliases: bool,
    /// `privacyForCaller`: false when an operator relaxed remote privacy, which drops the privacy part of the
    /// page policy and leaves the member-access part.
    pub entity_privacy: bool,
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

/// Whether the page policy `privatePagesFilterForCaller(p)` hides `page`: the member-access part
/// for the empty identity, then the privacy part unless `entity_privacy` is false.
pub(crate) fn page_hidden(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let allowed = readers_allowed(read, page)?
        && (!policy.entity_privacy || privacy_allows(read, page, policy.honor_aliases)?);
    Ok(!allowed)
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

/// The slugs an origin reference names in `source_id` (`gbrain_access_origin_restricted`): the slug, and
/// (with no slug aliases or rename history in this store) nothing else.
fn origin_slugs(slug: &str) -> Vec<String> {
    vec![slug.to_string()]
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
    any_page_where(read, source_id, &origin_slugs(slug), test)
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
/// `source_slug`. The rename alias and `slug_rename_history` slugs the probe also reads do not exist
/// in this store.
fn atom_origin_private(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let source = page.source_id.as_str();
    let Some(slug) = text(&page.frontmatter, "source_slug") else {
        return Ok(false);
    };
    any_page_where(read, source, &origin_slugs(&slug), explicitly_private)
}

/// `declaredLineagePrivateSql`: a page named in `derived_from` is explicitly private.
fn declared_lineage_private(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    match declared_slugs(&page.frontmatter) {
        Some(slugs) => any_page_where(read, &page.source_id, &slugs, explicitly_private),
        None => Ok(false),
    }
}
