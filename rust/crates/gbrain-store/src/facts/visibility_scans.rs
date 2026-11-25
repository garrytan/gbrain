//! The preview reads of `gbrain repair visibility` (src/core/repair/visibility.ts):
//!
//! - `listAtomLineageRows`, `listChronicleEventVisibilityRows`, `listAliasOnlyPrivatePages`
//!   (src/core/engine-sql/visibility-scans.ts): the atom-lineage, Life Chronicle event and alias-only classes.
//! - `listConceptLineageRows`, `listConceptInputRows`, `listNamedVisibilityRows` (src/core/engine-sql/facts-repair.ts):
//!   the synthesized concepts, their inputs and the pages a `--slug` names.
//!
//! Each answers the statement from the page, link, alias and rename records: `length(compiled_truth)` is the body's
//! length in characters (null for a segmented page), `frontmatter->>key` the field's text, and `folderRestrictedSql` is
//! [`folder_restricted`]. The store keeps no `page_label_guards` rows, so `guarded` is false for every named page.
//! Rows come back by id, as each statement orders them; `listConceptInputRows` (no `ORDER BY`) by (concept, atom).

use super::privacy::alias_private;
use super::repair::folder_restricted;
use crate::Store;
use crate::aliases::{read_slug_alias, renamed_to};
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::page_body::segmented_body_bytes;
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The scans' arguments: the sources, and the page ids (`ids`) or slugs (`slugs`) that narrow them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibilityScanArgs {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub ids: Option<Vec<i64>>,
    #[serde(default)]
    pub slugs: Option<Vec<String>>,
}

/// One identity outside an open-twins change: its principals (empty when not valid) and its satisfied folder rules
/// (sorted and distinct; empty when any is not valid), as the readers and folder-rule builders render them.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenTwinReader {
    pub identity: Vec<String>,
    pub satisfied: Vec<String>,
}

/// `listOpenTwinRows({ pages, outside, honorAliases })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenTwinArgs {
    pub pages: Vec<TwinPage>,
    pub outside: Vec<OpenTwinReader>,
    pub honor_aliases: bool,
}

/// A changed page of an open-twins scan.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TwinPage {
    pub source_id: String,
    pub slug: String,
}

fn field(fm: &Map<String, Value>, key: &str) -> Option<String> {
    fm.get(key).and_then(jsonb_field_text)
}

/// `length(compiled_truth)`: characters, null for a segmented page's NULL body.
fn chars(page: &PageRecord) -> Value {
    json!(
        page.compiled_truth
            .as_deref()
            .map(|body| body.chars().count())
    )
}

/// The live pages of the sources (by id), narrowed to `ids` when given.
fn live_pages(read: &dyn KvRead, a: &VisibilityScanArgs) -> Result<Vec<PageRecord>> {
    let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
    let ids: Option<BTreeSet<i64>> = a.ids.as_ref().map(|ids| ids.iter().copied().collect());
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| {
            p.deleted_at_us.is_none()
                && sources.contains(p.source_id.as_str())
                && ids.as_ref().is_none_or(|ids| ids.contains(&(p.id as i64)))
        })
        .collect();
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

fn base_row(page: &PageRecord, visibility: Value) -> Value {
    json!({ "id": page.id, "source_id": page.source_id, "slug": page.slug, "type": page.page_type,
        "visibility": visibility, "chars": chars(page) })
}

/// The origin columns of a row: the live page `slug` names in the source, its type, frontmatter and folder restriction.
fn with_origin(
    read: &dyn KvRead,
    mut row: Value,
    source: &str,
    slug: Option<&str>,
) -> Result<Value> {
    let origin = match slug {
        Some(slug) => read_page(read, source, slug)?.filter(|o| o.deleted_at_us.is_none()),
        None => None,
    };
    let restricted = match &origin {
        Some(o) => folder_restricted(read, o)?,
        None => false,
    };
    row["origin_id"] = json!(origin.as_ref().map(|o| o.id));
    row["origin_type"] = json!(origin.as_ref().map(|o| o.page_type.clone()));
    row["origin_frontmatter"] = json!(
        origin
            .as_ref()
            .map(|o| crate::jsonb::order_map(o.frontmatter.clone()))
    );
    row["origin_folder_restricted"] = json!(restricted);
    Ok(row)
}

/// `atomOriginSlugSql`: the atom's `source_slug` while any page row holds it, deleted or not, else the slug its `rename`
/// alias moved that page to (null when it has none).
fn atom_origin_slug(read: &dyn KvRead, source: &str, slug: &str) -> Result<Option<String>> {
    if read_page(read, source, slug)?.is_some() {
        return Ok(Some(slug.to_string()));
    }
    Ok(match read_slug_alias(read, source, slug)? {
        Some(alias) if alias.notes.as_deref() == Some("rename") => Some(alias.canonical_slug),
        _ => Some(slug.to_string()),
    })
}

/// `atomMovedOriginPrivateSql`: a page a rename moved the atom's `source_slug` to is explicitly private.
fn moved_origin_private(read: &dyn KvRead, source: &str, slug: Option<&str>) -> Result<bool> {
    let Some(slug) = slug else {
        return Ok(false);
    };
    for new in renamed_to(read, source, slug)? {
        if let Some(page) = read_page(read, source, &new)?
            && field(&page.frontmatter, "visibility").as_deref() == Some("private")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `readersAllowedSql(t, identity)` on a pages row: no readers named, or a named reader is one of `identity`.
fn readers_allowed(page: &PageRecord, identity: &[String]) -> bool {
    if !page.frontmatter.contains_key("readable_by") {
        return true;
    }
    !identity.is_empty()
        && super::privacy::access_readers(&page.frontmatter)
            .is_some_and(|readers| readers.iter().any(|r| identity.contains(r)))
}

/// `folderRulesAllowedSql(t, satisfied)` read live: no folder rule stamped, or every stamped rule satisfied; and no
/// pending prefix of the page's source covers its slug.
fn folder_rules_allowed(
    read: &dyn KvRead,
    page: &PageRecord,
    satisfied: &[String],
) -> Result<bool> {
    let stamped = match crate::access_policy::kept_rule_ids(read, &page.source_id, page.id)? {
        None => true,
        Some(kept) => !satisfied.is_empty() && kept.iter().all(|id| satisfied.contains(id)),
    };
    Ok(stamped && !crate::access_rules::pending_covers(read, &page.source_id, &page.slug)?)
}

impl Store {
    /// `listOpenTwinRows({ pages, outside, honorAliases })`: per live page of another source at a changed page's slug
    /// (not itself a changed page) that passes the snapshot filter and that some outside identity may read by its
    /// readers and folder rules, `{ source_id, slug, twin_of, n }`: `twin_of` the smallest source of the changed pages it
    /// twins, `n` how many such pages there are. By (source, slug) in byte order, at most 50.
    pub fn list_open_twin_rows(&self, a: &OpenTwinArgs) -> Result<Vec<Value>> {
        let window: BTreeSet<(&str, &str)> = a
            .pages
            .iter()
            .map(|p| (p.source_id.as_str(), p.slug.as_str()))
            .collect();
        let read = self.read()?;
        let mut twins: BTreeMap<(String, String), String> = BTreeMap::new();
        for t in all_pages(&*read)? {
            if t.deleted_at_us.is_some()
                || window.contains(&(t.source_id.as_str(), t.slug.as_str()))
            {
                continue;
            }
            let Some(twin_of) = a
                .pages
                .iter()
                .filter(|c| c.slug == t.slug && c.source_id != t.source_id)
                .map(|c| c.source_id.as_str())
                .min()
            else {
                continue;
            };
            if !super::privacy::snapshot_fields_allow(&t.page_type, &t.frontmatter, a.honor_aliases)
            {
                continue;
            }
            let mut readable = false;
            for reader in &a.outside {
                if readers_allowed(&t, &reader.identity)
                    && folder_rules_allowed(&*read, &t, &reader.satisfied)?
                {
                    readable = true;
                    break;
                }
            }
            if readable {
                twins.insert((t.source_id.clone(), t.slug.clone()), twin_of.to_string());
            }
        }
        let n = twins.len();
        Ok(twins
            .into_iter()
            .take(50)
            .map(|((source_id, slug), twin_of)| json!({ "source_id": source_id, "slug": slug, "twin_of": twin_of, "n": n }))
            .collect())
    }

    /// `listAtomLineageRows({ sourceIds, ids })`: the live atoms, each with its origin page and the moved-origin test.
    pub fn list_atom_lineage_rows(&self, a: &VisibilityScanArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for atom in live_pages(&*read, a)?
            .into_iter()
            .filter(|p| p.page_type == "atom")
        {
            let source_slug = field(&atom.frontmatter, "source_slug");
            let origin = match source_slug.as_deref() {
                Some(slug) => atom_origin_slug(&*read, &atom.source_id, slug)?,
                None => None,
            };
            let mut row = base_row(&atom, json!(field(&atom.frontmatter, "visibility")));
            row["source_slug"] = json!(source_slug);
            let mut row = with_origin(&*read, row, &atom.source_id, origin.as_deref())?;
            row["origin_moved_private"] = json!(moved_origin_private(
                &*read,
                &atom.source_id,
                source_slug.as_deref()
            )?);
            out.push(row);
        }
        Ok(out)
    }

    /// `listChronicleEventVisibilityRows({ sourceIds, ids })`: the live Life Chronicle events not already private, each
    /// with the live page its `event.depth` names.
    pub fn list_chronicle_event_visibility_rows(
        &self,
        a: &VisibilityScanArgs,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for event in live_pages(&*read, a)? {
            let chronicle = event.page_type == "event"
                && field(&event.frontmatter, "captured_via")
                    .is_some_and(|via| via.starts_with("life-chronicle:"));
            let visibility = field(&event.frontmatter, "visibility");
            if !chronicle || visibility.as_deref() == Some("private") {
                continue;
            }
            let depth = event
                .frontmatter
                .get("event")
                .and_then(|e| e.get("depth"))
                .and_then(jsonb_field_text);
            let row = base_row(&event, json!(visibility));
            out.push(with_origin(
                &*read,
                row,
                &event.source_id,
                depth.as_deref(),
            )?);
        }
        Ok(out)
    }

    /// `listAliasOnlyPrivatePages({ sourceIds, ids })`: the live pages with no `visibility` that a privacy alias makes
    /// private, other than atoms, synthesized concepts and Life Chronicle events.
    pub fn list_alias_only_private_pages(&self, a: &VisibilityScanArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(live_pages(&*read, a)?
            .into_iter()
            .filter(|p| {
                let fm = &p.frontmatter;
                field(fm, "visibility").is_none()
                    && alias_private(fm)
                    && p.page_type != "atom"
                    && !(p.page_type == "concept" && field(fm, "synthesized_by").is_some())
                    && !(p.page_type == "event"
                        && field(fm, "captured_via")
                            .is_some_and(|via| via.starts_with("life-chronicle:")))
            })
            .map(|p| base_row(&p, Value::Null))
            .collect())
    }

    /// `listConceptLineageRows({ sourceIds, ids })`: the live synthesized concepts.
    pub fn list_concept_lineage_rows(&self, a: &VisibilityScanArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(live_pages(&*read, a)?
            .into_iter()
            .filter(|p| {
                p.page_type == "concept" && field(&p.frontmatter, "synthesized_by").is_some()
            })
            .map(|p| base_row(&p, json!(field(&p.frontmatter, "visibility"))))
            .collect())
    }

    /// `listConceptInputRows({ ids })`: each (concept, atom) input of the named concepts, `linked` when a
    /// concept-provenance link names it (else only the atom's `concepts:` list does): the link's live atom of the
    /// concept's source, or a live atom of that source whose `concepts:` entry, past its last `/`, is the concept's slug
    /// without `concepts/`.
    pub fn list_concept_input_rows(&self, a: &VisibilityScanArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut concepts: Vec<PageRecord> = Vec::new();
        for id in a.ids.iter().flatten().copied().collect::<BTreeSet<i64>>() {
            if let Ok(id) = u64::try_from(id)
                && let Some(page) = read_page_by_id(&*read, id)?
            {
                concepts.push(page);
            }
        }
        let sources: BTreeSet<&str> = concepts.iter().map(|c| c.source_id.as_str()).collect();
        let atoms: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.page_type == "atom"
                    && p.deleted_at_us.is_none()
                    && sources.contains(p.source_id.as_str())
            })
            .collect();
        let mut members: BTreeMap<(u64, u64), bool> = BTreeMap::new();
        for concept in &concepts {
            for link in out_links(&*read, concept.id)? {
                if link.link_source.as_deref() == Some("concept-provenance")
                    && link.link_type == "synthesized_from"
                    && let Some(atom) = read_page_by_id(&*read, link.to_page_id)?
                    && atom.source_id == concept.source_id
                    && atom.page_type == "atom"
                    && atom.deleted_at_us.is_none()
                {
                    members.insert((concept.id, atom.id), true);
                }
            }
            let name = concept
                .slug
                .strip_prefix("concepts/")
                .unwrap_or(&concept.slug);
            for atom in atoms
                .iter()
                .filter(|atom| atom.source_id == concept.source_id)
            {
                let refs = match atom.frontmatter.get("concepts") {
                    Some(Value::Array(items)) => items
                        .iter()
                        .filter_map(jsonb_field_text)
                        .collect::<Vec<_>>(),
                    _ => Vec::new(),
                };
                if refs
                    .iter()
                    .any(|r| r.rsplit('/').next().unwrap_or(r) == name)
                {
                    members.entry((concept.id, atom.id)).or_insert(false);
                }
            }
        }
        Ok(members
            .into_iter()
            .map(|((concept_id, atom_id), linked)| json!({ "concept_id": concept_id, "atom_id": atom_id, "linked": linked }))
            .collect())
    }

    /// `listNamedVisibilityRows({ sourceIds, slugs })`: the live pages of the sources at those slugs, with their stored
    /// visibility, `COALESCE(body_bytes, 0)` and whether a label guard is raised (never, here: the store keeps no
    /// `page_label_guards` rows).
    pub fn list_named_visibility_rows(&self, a: &VisibilityScanArgs) -> Result<Vec<Value>> {
        let slugs: BTreeSet<&str> = a.slugs.iter().flatten().map(String::as_str).collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for page in live_pages(&*read, a)?
            .into_iter()
            .filter(|p| slugs.contains(p.slug.as_str()))
        {
            out.push(json!({ "id": page.id, "source_id": page.source_id, "slug": page.slug, "type": page.page_type,
                "visibility": field(&page.frontmatter, "visibility"), "chars": segmented_body_bytes(&*read, page.id)?.unwrap_or(0),
                "guarded": false }));
        }
        Ok(out)
    }
}
