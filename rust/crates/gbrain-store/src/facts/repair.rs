//! Group 5 facts reads, repair classifiers and loop retirement (src/core/engine-sql/facts-repair.ts).
//!
//! The store serves the four statements that read only `facts` and `pages`:
//!
//! - `listSessionFactsForClassification` and `listSessionFactTwins` (repair/agent-session-facts.ts),
//! - `listCapturedFactsForClassification` (repair/captured-facts.ts),
//! - `listWorldFactsFromPrivateSources` (repair/visibility.ts).
//!
//! It also serves `countLabelFacts` (repair/conversation-labels.ts), which reads facts, pages,
//! loops and withdrawals: the TypeScript member reads its label line into literal labels
//! (`store-members/label-line.ts`) and [`has_label_line`] matches them, so the store evaluates no
//! regular expression.
//!
//! The two loop reads, `closedLoopWithActiveFact` and `loopFactDrift`, are served from
//! `facts/loops.rs`. `countPurgedPageFacts` (doctor's gone-page check) also reads the store's
//! `page_purges` ledger (`facts/page_purges.rs`), `listUnwithdrawnFacts` is served from the derived
//! generation ledger in `facts/generations.rs`, and `listExtractorFactsForClassification` is served
//! from `facts/extractor_classify.rs`. rust/docs/store/facts.md names each one.
//!
//! Shared reading rules. A source's rows come back in id order ([`source_rows`]); the sources are
//! visited in byte order of their id, which is `ORDER BY f.source_id, f.id` under the C collation
//! the parity brains use. A fact's `gbrain_fact_fingerprint` is [`fact_fingerprint`]. `attributed_to
//! IS NULL OR = 'user'` is [`user_or_unset`]. `a.entity_slug IS NOT DISTINCT FROM f.entity_slug` is
//! plain `Option` equality.

use super::loops::loop_fact_ids;
use super::page_purges::source_purges;
use super::privacy::stamped_rules;
use super::{FactRecord, fact_fingerprint, ids_under, refs_prefix, source_rows};
use crate::Store;
use crate::access_rules::pending_covers;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page};
use crate::timeline_queries::jsonb_field_text;
use crate::trust::withdrawals::withdrawn_claim;
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

/// The scope and constants of `countLabelFacts`. The TypeScript member reads the label line
/// (`~* $4`) into the literal labels its alternation spells and the `LIKE '%…%'` context pattern
/// into the text it looks for; it refuses any other shape, so the store evaluates no regular
/// expression.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelCountArgs {
    pub source_ids: Vec<String>,
    /// `LIMIT $5`: the most rows to count (`cap + 1`).
    pub limit: u64,
    /// `f.source = $2`.
    pub segment_source: String,
    /// `f.context LIKE '%' || context_contains || '%'`.
    pub context_contains: String,
    /// The labels of `(^|\n)\*\*(labels)[[:space:]]*:\*\*`, ASCII, matched with ASCII case folding.
    pub labels: Vec<String>,
    /// `o.source IN ($6, $7)`: the audit sources that mark a page as decided.
    pub terminal_source: String,
    pub non_extractable_source: String,
}

/// `countPurgedPageFacts(sourceIds, cap)`: `limit` is the SQL's `LIMIT cap + 1`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgedCountArgs {
    pub source_ids: Vec<String>,
    pub limit: u64,
}

/// `listPurgedPageFactCandidates(sourceIds, ids)`: the fact ids when the caller names them
/// (`$2::bigint[] IS NULL OR f.id = ANY($2)`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgedCandidatesArgs {
    pub source_ids: Vec<String>,
    pub ids: Option<Vec<i64>>,
}

/// `PAGE_EXTRACTION_SOURCE_LIST` (facts/gone-page-facts.ts): the sources whose context names the page.
pub(crate) const PAGE_EXTRACTION_SOURCES: [&str; 4] =
    ["mcp:put_page", "sync:import", "file_upload", "code_import"];

/// `contextHeadSql`: `split_part(context, ' — ', 1)`, the text before the first separator.
pub(crate) fn context_head(context: &str) -> &str {
    context.split(" \u{2014} ").next().unwrap_or("")
}

/// The literal prefix of `f.source LIKE 'cli:extract-conversation-facts%'`.
const EXTRACTOR_PREFIX: &str = "cli:extract-conversation-facts";

/// `[[:space:]]` as PGLite reads it: `iswspace` of its C library (musl) under `C.UTF-8`. Postgres
/// on glibc also counts U+1680 (OGHAM SPACE MARK); the parity cases use none of the two
/// characters on which the two disagree.
pub(super) fn posix_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t'
            | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | '\u{85}'
            | '\u{2000}'..='\u{2006}'
            | '\u{2008}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// `text ~* '(^|\n)\*\*(labels)[[:space:]]*:\*\*'`: a line opens with `**`, one of the labels
/// (ASCII case folding: `~*` matches an ASCII letter of the pattern only in its two ASCII cases),
/// any run of `[[:space:]]`, then `:**`.
pub(super) fn has_label_line(text: &str, labels: &[String]) -> bool {
    let starts = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1));
    starts.into_iter().any(|at| {
        let Some(rest) = text[at..].strip_prefix("**") else {
            return false;
        };
        labels.iter().any(|label| {
            rest.get(..label.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(label))
                && rest[label.len()..]
                    .trim_start_matches(posix_space)
                    .starts_with(":**")
        })
    })
}

/// `context ~ 'extractor_version=[0-9]+$'`: the text ends with `extractor_version=` and one or
/// more ASCII digits.
pub(super) fn version_stamped(context: &str) -> bool {
    let head = context.trim_end_matches(|c: char| c.is_ascii_digit());
    head.len() < context.len() && head.ends_with("extractor_version=")
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
                let held_private = match held.as_ref() {
                    Some(page) if page.deleted_at_us.is_none() => {
                        derivation_private(&*read, page, args.honor_aliases)?
                    }
                    _ => false,
                };
                let origin_private = match origin.as_ref() {
                    Some(page) => derivation_private(&*read, page, args.honor_aliases)?,
                    None => false,
                };
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

    /// `countLabelFacts(sourceIds, cap, args)` before its cap: how many active segment facts (at
    /// most `limit`) sit on a live page whose body or timeline carries a label line, on a page no
    /// version-stamped audit fact decided, neither superseded nor a successor, named by no loop and
    /// covered by no withdrawal. The SQL has no ORDER BY; only the count is observable.
    pub fn count_label_facts(&self, a: &LabelCountArgs) -> Result<u64> {
        let op = "countLabelFacts";
        for source in &a.source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        no_nul(
            op,
            &[
                ("segmentSource", &a.segment_source),
                ("contextContains", &a.context_contains),
                ("terminalSource", &a.terminal_source),
                ("nonExtractableSource", &a.non_extractable_source),
            ],
        )?;
        for label in &a.labels {
            no_nul(op, &[("labels", label)])?;
        }
        if a.limit == 0 || !a.segment_source.starts_with(EXTRACTOR_PREFIX) {
            return Ok(0);
        }
        let read = self.read()?;
        let held = loop_fact_ids(&*read, op)?;
        let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        let mut n = 0u64;
        for source in sources {
            let rows = source_rows(&*read, source)?;
            let decided: BTreeSet<&str> = rows
                .iter()
                .filter(|o| {
                    o.expired_at_us.is_none()
                        && (o.source == a.terminal_source || o.source == a.non_extractable_source)
                        && o.context.as_deref().is_some_and(version_stamped)
                })
                .filter_map(|o| o.source_markdown_slug.as_deref())
                .collect();
            let mut labelled: HashMap<&str, bool> = HashMap::new();
            for f in &rows {
                let Some(slug) = f.source_markdown_slug.as_deref() else {
                    continue;
                };
                if f.source != a.segment_source
                    || f.expired_at_us.is_some()
                    || f.superseded_by.is_some()
                    || !f
                        .context
                        .as_deref()
                        .is_some_and(|c| c.contains(&a.context_contains))
                    || decided.contains(slug)
                {
                    continue;
                }
                let on_label_page = match labelled.get(slug) {
                    Some(known) => *known,
                    None => {
                        let found = read_page(&*read, source, slug)?.is_some_and(|p| {
                            p.deleted_at_us.is_none()
                                && (has_label_line(
                                    p.compiled_truth.as_deref().unwrap_or(""),
                                    &a.labels,
                                ) || has_label_line(
                                    p.timeline.as_deref().unwrap_or(""),
                                    &a.labels,
                                ))
                        });
                        labelled.insert(slug, found);
                        found
                    }
                };
                if !on_label_page
                    || held.contains(&f.id)
                    || !ids_under(&*read, &refs_prefix(f.id))?.is_empty()
                    || withdrawn_claim(
                        &*read,
                        source,
                        &f.visibility,
                        &f.fact,
                        f.entity_slug.as_deref(),
                    )?
                {
                    continue;
                }
                n += 1;
                if n >= a.limit {
                    return Ok(n);
                }
            }
        }
        Ok(n)
    }

    /// `countPurgedPageFacts` (engine-sql/facts-repair.ts): for each gone-page fact, at most `limit`, whether a
    /// purge record names its page. A gone-page fact is active, filed on no page, from a page-extraction source,
    /// with a context head that is not empty, holds no `[[:space:]]` ([`posix_space`]) and names no page row
    /// (live or soft-deleted) of its source. It counts when its head holds a `/` or a tombstone of its source
    /// names the head at or after the fact's `created_at`, and no withdrawal, successor, referrer or loop holds it.
    /// Sources go in byte order, facts in id order (the SQL has no ORDER BY; the member only caps the list).
    pub fn count_purged_page_facts(&self, a: &PurgedCountArgs) -> Result<Vec<bool>> {
        let op = "countPurgedPageFacts";
        for source in &a.source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        let mut out = Vec::new();
        if a.limit == 0 {
            return Ok(out);
        }
        let read = self.read()?;
        let held = loop_fact_ids(&*read, op)?;
        let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        for source in sources {
            let purges = source_purges(&*read, source, op)?;
            let mut page_row: HashMap<String, bool> = HashMap::new();
            for f in source_rows(&*read, source)? {
                if f.expired_at_us.is_some()
                    || f.source_markdown_slug.is_some()
                    || !PAGE_EXTRACTION_SOURCES.contains(&f.source.as_str())
                {
                    continue;
                }
                let Some(head) = f.context.as_deref().map(context_head) else {
                    continue;
                };
                if head.is_empty() || head.chars().any(posix_space) {
                    continue;
                }
                let has_row = match page_row.get(head) {
                    Some(known) => *known,
                    None => {
                        let found = read_page(&*read, source, head)?.is_some();
                        page_row.insert(head.to_string(), found);
                        found
                    }
                };
                if has_row {
                    continue;
                }
                let purged = purges
                    .iter()
                    .any(|(slug, at)| slug == head && *at >= f.created_at_us);
                if !(head.contains('/') || purged)
                    || f.superseded_by.is_some()
                    || held.contains(&f.id)
                    || !ids_under(&*read, &refs_prefix(f.id))?.is_empty()
                    || withdrawn_claim(
                        &*read,
                        source,
                        &f.visibility,
                        &f.fact,
                        f.entity_slug.as_deref(),
                    )?
                {
                    continue;
                }
                out.push(purged);
                if out.len() as u64 >= a.limit {
                    return Ok(out);
                }
            }
        }
        Ok(out)
    }

    /// `listPurgedPageFactCandidates` (engine-sql/facts-repair.ts): the gone-page facts of the sources (the
    /// filter of [`Store::count_purged_page_facts`]), each with its exclusion flags (`withdrawn`, `superseded`,
    /// `referenced`, `open_loop`) and whether a purge record names its page (`purged`), by (source, page head, id)
    /// in byte order. Nothing is dropped for an exclusion: the caller classifies. `ids` narrows the read.
    pub fn list_purged_page_fact_candidates(&self, a: &PurgedCandidatesArgs) -> Result<Vec<Value>> {
        let op = "listPurgedPageFactCandidates";
        for source in &a.source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        let read = self.read()?;
        let held = loop_fact_ids(&*read, op)?;
        let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for source in sources {
            let purges = source_purges(&*read, source, op)?;
            let mut page_row: HashMap<String, bool> = HashMap::new();
            let mut found: Vec<(String, FactRecord, bool)> = Vec::new();
            for f in source_rows(&*read, source)? {
                if f.expired_at_us.is_some()
                    || f.source_markdown_slug.is_some()
                    || !PAGE_EXTRACTION_SOURCES.contains(&f.source.as_str())
                    || !wanted(&a.ids, &f)
                {
                    continue;
                }
                let Some(head) = f.context.as_deref().map(context_head) else {
                    continue;
                };
                if head.is_empty() || head.chars().any(posix_space) {
                    continue;
                }
                let has_row = match page_row.get(head) {
                    Some(known) => *known,
                    None => {
                        let found = read_page(&*read, source, head)?.is_some();
                        page_row.insert(head.to_string(), found);
                        found
                    }
                };
                if has_row {
                    continue;
                }
                let purged = purges
                    .iter()
                    .any(|(slug, at)| slug == head && *at >= f.created_at_us);
                if !(head.contains('/') || purged) {
                    continue;
                }
                found.push((head.to_string(), f, purged));
            }
            found.sort_by(|x, y| (&x.0, x.1.id).cmp(&(&y.0, y.1.id)));
            for (head, f, purged) in found {
                out.push(json!({
                    "id": f.id, "source_id": f.source_id, "slug": head, "fact": f.fact,
                    "context": f.context, "entity_slug": f.entity_slug,
                    "visibility": f.visibility, "source": f.source,
                    "withdrawn": withdrawn_claim(
                        &*read, source, &f.visibility, &f.fact, f.entity_slug.as_deref(),
                    )?,
                    "superseded": f.superseded_by.is_some(),
                    "referenced": !ids_under(&*read, &refs_prefix(f.id))?.is_empty(),
                    "open_loop": held.contains(&f.id),
                    "purged": purged,
                }));
            }
        }
        Ok(out)
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
pub(crate) fn provenance_slug(row: &FactRecord) -> Option<String> {
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
/// aliases are honoured), the page names readers (`readable_by`), or it sits under a folder
/// ([`folder_restricted`]).
pub(crate) fn derivation_private(
    read: &dyn KvRead,
    page: &PageRecord,
    honor_aliases: bool,
) -> Result<bool> {
    Ok(!snapshot_allows(page, honor_aliases)
        || alias_private(&page.frontmatter)
        || page.frontmatter.contains_key("readable_by")
        || folder_restricted(read, page)?)
}

/// `folderRestrictedSql`: a folder rule is stamped on the page, or a pending or invalid prefix of
/// its source covers its slug.
pub(crate) fn folder_restricted(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(
        !stamped_rules(read, page)?.is_empty()
            || pending_covers(read, &page.source_id, &page.slug)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_space_class_matches_pglite_on_every_code_point() {
        let mismatches = crate::fingerprint_fixture::space_mismatches(posix_space);
        assert_eq!(mismatches, Vec::<String>::new());
    }

    #[test]
    fn the_context_head_is_the_text_before_the_first_separator() {
        assert_eq!(context_head("notes/a \u{2014} b \u{2014} c"), "notes/a");
        assert_eq!(context_head("notes/a"), "notes/a");
        assert_eq!(context_head("notes/a \u{2014}b"), "notes/a \u{2014}b");
        assert_eq!(context_head(""), "");
    }

    #[test]
    fn a_purge_record_of_the_head_written_at_or_after_the_fact_is_the_evidence() {
        use crate::facts::InsertFactsArgs;
        use crate::facts::page_purges::put_purge;
        let store = crate::test_support::store();
        let rows: Vec<Value> = ["early", "purged", "notes/gone", "elsewhere"]
            .iter()
            .map(|c| {
                json!({ "fact": format!("claim {c}"), "visibility": "private", "source": "mcp:put_page",
                    "valid_from": "2026-01-01T00:00:00.000Z", "context": format!("{c} \u{2014} x") })
            })
            .collect();
        let insert: InsertFactsArgs =
            serde_json::from_value(json!({ "rows": rows, "sourceId": "default" })).unwrap();
        store.insert_facts(&insert).unwrap();
        store
            .write(|tx| {
                put_purge(tx, "default", "h1", "early", 0)?;
                put_purge(tx, "default", "h2", "purged", i64::MAX)?;
                put_purge(tx, "default", "h3", "elsewhere-not", i64::MAX)
            })
            .unwrap();
        let count = |limit| {
            store
                .count_purged_page_facts(&PurgedCountArgs {
                    source_ids: vec!["default".into()],
                    limit,
                })
                .unwrap()
        };
        // `early` was purged before its fact and `elsewhere` has no record: neither has a `/`, so only
        // `purged` (evidenced) and `notes/gone` (ambiguous) count, in id order.
        assert_eq!(count(10), vec![true, false]);
        assert_eq!(count(1), vec![true]);
        assert!(count(0).is_empty());
    }

    #[test]
    fn candidates_carry_the_purge_evidence_and_the_exclusion_flags_in_head_order() {
        use crate::facts::InsertFactsArgs;
        use crate::facts::page_purges::put_purge;
        let store = crate::test_support::store();
        let rows: Vec<Value> = [
            ("notes/zeta", "mcp:put_page"),
            ("purged", "sync:import"),
            ("notes/alpha \u{2014} x", "mcp:put_page"),
            ("early", "mcp:put_page"),
            ("notes/alpha", "mcp:remember"),
            ("two words \u{2014} x", "mcp:put_page"),
        ]
        .iter()
        .map(|(c, source)| {
            json!({ "fact": format!("claim {c}"), "visibility": "private", "source": source,
                "valid_from": "2026-01-01T00:00:00.000Z", "context": c })
        })
        .collect();
        let insert: InsertFactsArgs =
            serde_json::from_value(json!({ "rows": rows, "sourceId": "default" })).unwrap();
        let ids = store.insert_facts(&insert).unwrap()["ids"].clone();
        store
            .write(|tx| {
                put_purge(tx, "default", "h1", "early", 0)?;
                put_purge(tx, "default", "h2", "purged", i64::MAX)
            })
            .unwrap();
        let list = |ids: Option<Vec<i64>>| {
            store
                .list_purged_page_fact_candidates(&PurgedCandidatesArgs {
                    source_ids: vec!["default".into()],
                    ids,
                })
                .unwrap()
        };
        // Page-extraction sources only; `early` was purged before its fact and `two words` has a space in its head:
        // neither is a candidate. The rest list by head in byte order, `purged` as the evidenced one.
        let rows = list(None);
        let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["notes/alpha", "notes/zeta", "purged"]);
        let flags: Vec<bool> = rows
            .iter()
            .map(|r| r["purged"].as_bool().unwrap())
            .collect();
        assert_eq!(flags, [false, false, true]);
        assert!(
            rows.iter()
                .all(|r| r["withdrawn"] == false && r["superseded"] == false)
        );
        assert!(
            rows.iter()
                .all(|r| r["referenced"] == false && r["open_loop"] == false)
        );
        // `ids` narrows the read.
        let one = list(Some(vec![ids[1].as_i64().unwrap()]));
        assert_eq!(one.len(), 1);
        assert_eq!(one[0]["slug"], "purged");
    }

    fn labels(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_label_line_opens_a_line_folds_ascii_case_and_allows_spaces_before_the_colon() {
        let l = labels(&["date", "action items", "action item"]);
        assert!(has_label_line("**Date:** x", &l));
        assert!(has_label_line("intro\n**DATE\u{2003}\t :** x", &l));
        assert!(has_label_line("a\r\n**action Items:**", &l));
        assert!(has_label_line("**Action Item:**", &l));
        assert!(!has_label_line("see **Date:** inline", &l));
        assert!(!has_label_line("**Dates:**", &l));
        assert!(!has_label_line("**Date\u{a0}:**", &l));
        assert!(!has_label_line("**Date:*", &l));
        assert!(!has_label_line("**\u{c9}ate:**", &l));
        assert!(!has_label_line("", &l));
    }

    #[test]
    fn a_version_stamp_ends_the_context() {
        assert!(version_stamped("decided extractor_version=3"));
        assert!(version_stamped("extractor_version=12"));
        assert!(!version_stamped("extractor_version="));
        assert!(!version_stamped("extractor_version=3 later"));
        assert!(!version_stamped("extractor_version=3\n"));
        assert!(!version_stamped("extractor_version=1x2"));
    }
}
