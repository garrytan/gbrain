//! The page row read of the generation adapters (`src/core/generations/adapters/page.ts`
//! `readPageRows`) over the page records (`pages.rs`).
//!
//! Member: readGenerationPageRows (the statements of `engine-sql/generation-page-rows.ts`). Each
//! `match` is one statement: the row of one slug (single-page), the outputs of a transcript
//! (synthesis), the atoms of an origin field (atoms) and the events of a depth page (Life
//! Chronicle). These are internal reads of derived pages, not caller page reads, so they take no
//! page read policy. Deleted rows are included. They add no keys.
//!
//! Order: the rows come in `P source \0 slug` key order, so by slug bytes, and tags sort by
//! bytes, as Postgres orders `ORDER BY p.slug COLLATE "C"` and
//! `jsonb_agg(t.tag ORDER BY t.tag COLLATE "C")` on every locale.
//!
//! `frontmatter->>'k'` is the key's text: a string is itself, JSON null or a missing key is
//! NULL, any other value is its jsonb text (so `true` matches `'true'`).

use crate::cli_reads::pg_text::jsonb_text;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::pages::PageRecord;
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const OP: &str = "readGenerationPageRows";

/// `GenerationPageRowsQuery` (engine-sql/generation-page-rows.ts). The fields each `match` uses
/// are checked by [`Match::of`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPageRowsQuery {
    pub source_id: String,
    #[serde(rename = "match")]
    pub match_kind: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub slugs: Option<Vec<String>>,
    #[serde(default)]
    pub locator: Option<String>,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub depth: Option<String>,
}

/// One checked statement.
enum Match<'q> {
    Slug(&'q str),
    Synthesis(BTreeSet<&'q str>, Option<&'q str>),
    Atoms(BTreeSet<&'q str>, &'q str, Option<&'q str>),
    Chronicle(BTreeSet<&'q str>, &'q str),
}

fn refuse(detail: &str) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, format!("{OP}: {detail}"))
}

fn slug_set(q: &GenerationPageRowsQuery) -> Result<BTreeSet<&str>> {
    let slugs = q
        .slugs
        .as_ref()
        .ok_or_else(|| refuse("slugs is required"))?;
    for slug in slugs {
        no_nul(OP, &[("slugs", slug.as_str())])?;
    }
    Ok(slugs.iter().map(String::as_str).collect())
}

impl<'q> Match<'q> {
    fn of(q: &'q GenerationPageRowsQuery) -> Result<Self> {
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        for (name, text) in [
            ("slug", &q.slug),
            ("locator", &q.locator),
            ("value", &q.value),
            ("depth", &q.depth),
        ] {
            if let Some(text) = text {
                no_nul(OP, &[(name, text.as_str())])?;
            }
        }
        match q.match_kind.as_str() {
            "slug" => Ok(Match::Slug(
                q.slug
                    .as_deref()
                    .ok_or_else(|| refuse("slug is required"))?,
            )),
            "synthesis" => Ok(Match::Synthesis(slug_set(q)?, q.locator.as_deref())),
            "atoms" => match q.field.as_deref() {
                Some(field @ ("source_slug" | "source_path")) => {
                    Ok(Match::Atoms(slug_set(q)?, field, q.value.as_deref()))
                }
                _ => Err(refuse("field must be source_slug or source_path")),
            },
            "chronicle" => Ok(Match::Chronicle(
                slug_set(q)?,
                q.depth
                    .as_deref()
                    .ok_or_else(|| refuse("depth is required"))?,
            )),
            other => Err(refuse(&format!("not a page row match: {other}"))),
        }
    }

    fn matches(&self, page: &PageRecord) -> bool {
        let live = page.deleted_at_us.is_none();
        let fm = &page.frontmatter;
        match self {
            Match::Slug(slug) => page.slug == *slug,
            Match::Synthesis(slugs, locator) => {
                slugs.contains(page.slug.as_str())
                    || (live
                        && locator.is_some_and(|locator| {
                            text_of(fm, "raw_source").as_deref() == Some(locator)
                                && text_of(fm, "dream_generated").as_deref() == Some("true")
                        }))
            }
            Match::Atoms(slugs, field, value) => {
                page.page_type == "atom"
                    && (slugs.contains(page.slug.as_str())
                        || (live
                            && value
                                .is_some_and(|value| text_of(fm, field).as_deref() == Some(value))))
            }
            Match::Chronicle(slugs, depth) => {
                slugs.contains(page.slug.as_str())
                    || (live
                        && page.page_type == "event"
                        && fm
                            .get("event")
                            .and_then(Value::as_object)
                            .is_some_and(|event| {
                                text_of(event, "depth").as_deref() == Some(*depth)
                            })
                        && text_of(fm, "captured_via")
                            .is_some_and(|via| via.starts_with("life-chronicle:")))
            }
        }
    }
}

/// `object->>'key'`.
pub(super) fn text_of(object: &Map<String, Value>, key: &str) -> Option<String> {
    match object.get(key)? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(jsonb_text(other)),
    }
}

impl Store {
    /// `readGenerationPageRows(query)`: the pages of `query.sourceId` the query's `match`
    /// selects, deleted rows included, by slug, as `{ page_id, slug, type, title,
    /// compiled_truth, timeline, frontmatter, deleted, segmented, tags }`.
    pub fn read_generation_page_rows(&self, query: &GenerationPageRowsQuery) -> Result<Vec<Value>> {
        let wanted = Match::of(query)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::text(keys::PAGE, &[&query.source_id, ""]),
            false,
            &mut |_, v| {
                match serde_json::from_slice::<PageRecord>(v) {
                    Ok(page) if page.source_id == query.source_id && wanted.matches(&page) => {
                        rows.push(page_row(&page));
                    }
                    Ok(_) => {}
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none()
            },
        )?;
        failure.map_or(Ok(rows), Err)
    }
}

fn page_row(page: &PageRecord) -> Value {
    let mut tags = page.tags.clone();
    tags.sort();
    tags.dedup();
    json!({
        "page_id": page.id,
        "slug": page.slug,
        "type": page.page_type,
        "title": page.title,
        "compiled_truth": page.compiled_truth.as_deref(),
        "timeline": page.timeline.as_deref(),
        "frontmatter": page.frontmatter,
        "deleted": page.deleted_at_us.is_some(),
        "segmented": page.compiled_truth.is_null() && page.timeline.is_null(),
        "tags": tags,
    })
}
