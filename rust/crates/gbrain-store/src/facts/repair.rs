//! Group 5 facts reads, repair classifiers and loop retirement (src/core/engine-sql/facts-repair.ts).
//!
//! The store serves the four statements that read only `facts` and `pages`:
//!
//! - `listSessionFactsForClassification` and `listSessionFactTwins` (repair/agent-session-facts.ts),
//! - `listCapturedFactsForClassification` (repair/captured-facts.ts),
//! - `listWorldFactsFromPrivateSources` (repair/visibility.ts).
//!
//! The other five members of the file read a table the store does not hold (`open_loops`,
//! `fact_withdrawals`, `persistence_requests`, `page_purges`, `derived_generations` and
//! `derived_generation_items`), so the TypeScript engine leaves them out of its member table and they
//! refuse with `engine_capability_missing`. rust/docs/store/facts.md names each one.
//!
//! Shared reading rules. A source's rows come back in id order ([`source_rows`]); the sources are
//! visited in byte order of their id, which is `ORDER BY f.source_id, f.id` under the C collation
//! the parity brains use. A fact's `gbrain_fact_fingerprint` is [`fact_fingerprint`]. `attributed_to
//! IS NULL OR = 'user'` is [`user_or_unset`]. `a.entity_slug IS NOT DISTINCT FROM f.entity_slug` is
//! plain `Option` equality.

use super::{FactRecord, fact_fingerprint, source_rows};
use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page};
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeSet, HashMap};

/// The scope of a classification read: the sources, the capture lanes, and the fact ids when the
/// caller names them (`$3::bigint[] IS NULL OR f.id = ANY($3)`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ClassifyArgs {
    pub source_ids: Vec<String>,
    pub lanes: Vec<String>,
    pub ids: Option<Vec<i64>>,
}

/// The facts named by `ids`, and the capture lanes whose twins are read.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TwinArgs {
    pub ids: Vec<i64>,
    pub lanes: Vec<String>,
}

/// The scope of the world-fact read and the one process setting its SQL renders.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldFactArgs {
    pub source_ids: Vec<String>,
    pub ids: Option<Vec<i64>>,
    /// `honorAliases()`, read from `privateSnapshotFilterFragment('h')`: a page with no
    /// `visibility` and a private `access` or `confidentiality` value is not readable.
    pub honor_aliases: bool,
}

/// `(a.attributed_to IS NULL OR a.attributed_to = 'user')`.
fn user_or_unset(row: &FactRecord) -> bool {
    row.attributed_to.as_deref().is_none_or(|a| a == "user")
}

/// `COALESCE(a.source, '') <> ALL(lanes)`: the row is not in a capture lane.
fn outside(lanes: &[String], row: &FactRecord) -> bool {
    !lanes.contains(&row.source)
}

/// `a.source = ANY(lanes)`.
fn inside(lanes: &[String], row: &FactRecord) -> bool {
    !outside(lanes, row)
}

/// `($3::bigint[] IS NULL OR f.id = ANY($3))`.
fn wanted(ids: &Option<Vec<i64>>, row: &FactRecord) -> bool {
    ids.as_ref().is_none_or(|ids| {
        ids.iter()
            .any(|id| u64::try_from(*id).is_ok_and(|id| id == row.id))
    })
}

/// The active, unsuperseded rows of the capture `lanes` in the sources, in (source, id) order.
fn lane_rows(read: &dyn crate::kv::KvRead, args: &ClassifyArgs) -> Result<Vec<FactRecord>> {
    let sources: BTreeSet<&str> = args.source_ids.iter().map(String::as_str).collect();
    let mut rows = Vec::new();
    for source in sources {
        for row in source_rows(read, source)? {
            if inside(&args.lanes, &row)
                && row.expired_at_us.is_none()
                && row.superseded_by.is_none()
                && wanted(&args.ids, &row)
            {
                rows.push(row);
            }
        }
    }
    Ok(rows)
}

fn check_scope(op: &str, source_ids: &[String], lanes: &[String]) -> Result<()> {
    for source in source_ids {
        no_nul(op, &[("sourceIds", source)])?;
    }
    for lane in lanes {
        no_nul(op, &[("lanes", lane)])?;
    }
    Ok(())
}

/// A source's rows with their fingerprints, read once per source.
struct SourceIndex<'a> {
    read: &'a dyn crate::kv::KvRead,
    sources: HashMap<String, Vec<(FactRecord, String)>>,
}

impl<'a> SourceIndex<'a> {
    fn new(read: &'a dyn crate::kv::KvRead) -> Self {
        Self {
            read,
            sources: HashMap::new(),
        }
    }

    fn rows(&mut self, source_id: &str) -> Result<&Vec<(FactRecord, String)>> {
        if !self.sources.contains_key(source_id) {
            let rows = source_rows(self.read, source_id)?
                .into_iter()
                .map(|row| {
                    let fingerprint = fact_fingerprint(&row.fact);
                    (row, fingerprint)
                })
                .collect();
            self.sources.insert(source_id.to_string(), rows);
        }
        Ok(&self.sources[source_id])
    }
}

impl Store {
    /// `listSessionFactsForClassification(sourceIds, lanes, ids)`: the active, unsuperseded facts of
    /// the capture lanes whose attribution is the user or unset, by (source, id).
    pub fn list_session_facts_for_classification(&self, args: &ClassifyArgs) -> Result<Vec<Value>> {
        check_scope(
            "listSessionFactsForClassification",
            &args.source_ids,
            &args.lanes,
        )?;
        let read = self.read()?;
        Ok(lane_rows(&*read, args)?
            .into_iter()
            .filter(user_or_unset)
            .map(|r| {
                json!({
                    "id": r.id,
                    "source_id": r.source_id,
                    "source_session": r.source_session,
                    "fact": r.fact,
                    "visibility": r.visibility,
                    "entity_slug": r.entity_slug,
                    "row_num": r.row_num,
                    "source_markdown_slug": r.source_markdown_slug,
                    "attributed_to": r.attributed_to,
                    "context": r.context,
                })
            })
            .collect())
    }

    /// `listSessionFactTwins(ids, lanes)`: for each fact named, whether an owner twin exists outside
    /// the capture lanes (`owner_twin`) and the distinct sessions of its capture-lane twins
    /// (`twin_sessions`, in text order; the SQL leaves the order open). A twin is another active,
    /// unsuperseded private or world fact of the same source with the same fingerprint and entity
    /// whose attribution is the user or unset. Rows come back by id.
    pub fn list_session_fact_twins(&self, args: &TwinArgs) -> Result<Vec<Value>> {
        check_scope("listSessionFactTwins", &[], &args.lanes)?;
        let read = self.read()?;
        let mut index = SourceIndex::new(&*read);
        let ids: BTreeSet<u64> = args
            .ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in ids {
            let Some(row) = super::read_fact(&*read, id)? else {
                continue;
            };
            let fingerprint = fact_fingerprint(&row.fact);
            let mut owner_twin = false;
            let mut sessions = BTreeSet::new();
            for (a, a_fingerprint) in index.rows(&row.source_id)? {
                if (a.visibility == "private" || a.visibility == "world")
                    && *a_fingerprint == fingerprint
                    && a.id != row.id
                    && a.expired_at_us.is_none()
                    && a.superseded_by.is_none()
                    && a.entity_slug == row.entity_slug
                    && user_or_unset(a)
                {
                    if outside(&args.lanes, a) {
                        owner_twin = true;
                    }
                    if inside(&args.lanes, a) {
                        sessions.insert(a.source_session.clone().unwrap_or_default());
                    }
                }
            }
            out.push(json!({
                "id": row.id,
                "owner_twin": owner_twin,
                "twin_sessions": sessions.into_iter().collect::<Vec<_>>(),
            }));
        }
        Ok(out)
    }

    /// `listCapturedFactsForClassification(sourceIds, lanes, ids)`: the active, unsuperseded facts
    /// of the capture lanes, each with its fingerprint and `legit_twin`: another active fact of the
    /// source (superseded or not) with the same visibility, entity and fingerprint outside the
    /// lanes. By (source, id).
    pub fn list_captured_facts_for_classification(
        &self,
        args: &ClassifyArgs,
    ) -> Result<Vec<Value>> {
        check_scope(
            "listCapturedFactsForClassification",
            &args.source_ids,
            &args.lanes,
        )?;
        let read = self.read()?;
        let mut index = SourceIndex::new(&*read);
        let mut out = Vec::new();
        for r in lane_rows(&*read, args)? {
            let fingerprint = fact_fingerprint(&r.fact);
            let legit_twin = index.rows(&r.source_id)?.iter().any(|(a, a_fingerprint)| {
                a.id != r.id
                    && a.expired_at_us.is_none()
                    && a.visibility == r.visibility
                    && a.entity_slug == r.entity_slug
                    && *a_fingerprint == fingerprint
                    && outside(&args.lanes, a)
            });
            out.push(json!({
                "id": r.id,
                "source_id": r.source_id,
                "source": r.source,
                "source_session": r.source_session,
                "fact": r.fact,
                "visibility": r.visibility,
                "entity_slug": r.entity_slug,
                "row_num": r.row_num,
                "source_markdown_slug": r.source_markdown_slug,
                "fingerprint": fingerprint,
                "legit_twin": legit_twin,
            }));
        }
        Ok(out)
    }

    /// `listWorldFactsFromPrivateSources(sourceIds, ids)`: the active `world` facts held in (`h`),
    /// or extracted from (`o`, the page `factProvenanceSlugSql` names), a page that is private by
    /// its visibility, a privacy alias or a `readable_by` list. `readable` is whether the holding
    /// page passes `privateSnapshotFilterFragment`. A folder rule is not read: the store holds no
    /// access tables, so no page is folder-restricted. By id.
    pub fn list_world_facts_from_private_sources(
        &self,
        args: &WorldFactArgs,
    ) -> Result<Vec<Value>> {
        for source in &args.source_ids {
            no_nul("listWorldFactsFromPrivateSources", &[("sourceIds", source)])?;
        }
        let read = self.read()?;
        let sources: BTreeSet<&str> = args.source_ids.iter().map(String::as_str).collect();
        let ids = args.ids.clone();
        let mut rows = Vec::new();
        for source in sources {
            for row in source_rows(&*read, source)? {
                if row.visibility != "world" || row.expired_at_us.is_some() || !wanted(&ids, &row) {
                    continue;
                }
                let held = match &row.source_markdown_slug {
                    Some(slug) => read_page(&*read, &row.source_id, slug)?,
                    None => None,
                };
                let origin = match provenance_slug(&row) {
                    Some(slug) => read_page(&*read, &row.source_id, &slug)?
                        .filter(|page| page.deleted_at_us.is_none()),
                    None => None,
                };
                let held_private = held.as_ref().is_some_and(|page| {
                    page.deleted_at_us.is_none() && derivation_private(page, args.honor_aliases)
                });
                let origin_private = origin
                    .as_ref()
                    .is_some_and(|page| derivation_private(page, args.honor_aliases));
                if !(held_private || origin_private) {
                    continue;
                }
                let readable = row.source_markdown_slug.is_none()
                    || held
                        .as_ref()
                        .is_none_or(|page| snapshot_allows(page, args.honor_aliases));
                rows.push((row, readable));
            }
        }
        rows.sort_by_key(|(row, _)| row.id);
        Ok(rows
            .into_iter()
            .map(|(r, readable)| {
                json!({
                    "id": r.id,
                    "source_id": r.source_id,
                    "row_num": r.row_num,
                    "source_markdown_slug": r.source_markdown_slug,
                    "entity_slug": r.entity_slug,
                    "readable": readable,
                })
            })
            .collect())
    }
}

/// The sources whose facts name their page in `context` (`factProvenanceSlugSql`).
const PAGE_SOURCES: [&str; 6] = [
    "mcp:put_page",
    "sync:import",
    "file_upload",
    "code_import",
    "hook:writeback",
    "mcp:extract_facts",
];

/// `factProvenanceSlugSql('f')`: the page a fact was extracted from. A `put_page:` or `sync:`
/// session names it (an empty remainder is still a name, not a fall-through); otherwise a page
/// source names it as the first space-separated word of `context`. One trailing `.md` goes.
fn provenance_slug(row: &FactRecord) -> Option<String> {
    let named = row
        .source_session
        .as_deref()
        .and_then(|s| {
            s.strip_prefix("put_page:")
                .or_else(|| s.strip_prefix("sync:"))
        })
        .map(str::to_string);
    let slug = named.or_else(|| {
        if !PAGE_SOURCES.contains(&row.source.as_str()) {
            return None;
        }
        let context = row.context.as_deref().unwrap_or("").trim_matches(' ');
        let first = context.split(' ').next().unwrap_or("");
        (!first.is_empty()).then(|| first.to_string())
    })?;
    Some(slug.strip_suffix(".md").map(str::to_string).unwrap_or(slug))
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

/// `privacyAliasSql`: an alias value, trimmed of edge spaces and ASCII lower-cased, is private.
fn alias_private(frontmatter: &Map<String, Value>) -> bool {
    PRIVACY_ALIASES.iter().any(|(key, values)| {
        text(frontmatter, key).is_some_and(|v| {
            let v = v.trim_matches(EDGE_SPACE).to_ascii_lowercase();
            values.contains(&v.as_str())
        })
    })
}

/// `privateSnapshotFilterFragment('h')`: `visibility` (an absent one is private on a derived page),
/// the `pinned_question` marker, and, when aliases are honoured, the privacy aliases of a page with
/// no `visibility`.
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

/// `derivationPrivateSql('h')`: the snapshot filter fails, a privacy alias is set (whether or not
/// aliases are honoured), the page names readers (`readable_by`), or a folder rule covers it (never
/// here: the store holds no folder rules).
fn derivation_private(page: &PageRecord, honor_aliases: bool) -> bool {
    !snapshot_allows(page, honor_aliases)
        || alias_private(&page.frontmatter)
        || page.frontmatter.contains_key("readable_by")
}
