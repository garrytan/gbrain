//! Group 5 facts reads, doctor checks (src/core/engine-sql/facts-doctor.ts): the facts statements
//! `gbrain doctor` ran through `executeRaw`, as `BrainEngine` members of the facts capability class.
//! Each function below answers one statement; the clause-by-clause reading is in its comment.
//!
//! What the TypeScript members refuse: `listUnpreviewedTrustFacts`, which has no store read yet
//! (the store keeps the write-gate holds and the `trust_tier` and `write_origin` columns it reads).
//! The unlinked-fact reads serve both forms: with `hasAttempts` the tried / paid / no-subject memos
//! read `fact_relink_attempts` (`facts/relink.rs`, `Memos`); without it every memo is `false`.
//!
//! Shared rules: `now()` is the store clock; text sorts in byte order; an array parameter is a set
//! (`= ANY`) except where the statement unnests it, which repeats an id given twice; a NUL byte in
//! any text refuses, as Postgres does.

use super::embedding::md5_hex;
use super::relink::Memos;
use super::{AUDIT_ROW_SOURCES, DAY_US, FactRecord, count_arg, like, source_rows};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::links::{no_nul, out_links};
use crate::pages::{all_pages, read_page, read_page_by_id};
use crate::sources::{SourceRecord, all_sources, read_source};
use crate::takes::all_takes;
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `EMBED_MAX_CHARS` (src/core/ai/embed-batch-plan.ts): the text `embed()` sends, in UTF-16 code units.
const EMBED_MAX_CHARS: usize = 8000;

/// `listConversationFactRows(sourceIds, limit)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationRowsQuery {
    pub source_ids: Vec<String>,
    pub limit: f64,
}

/// `countRedactedFacts(sourceIds?)`: `null` or absent counts every live source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactedQuery {
    pub source_ids: Option<Vec<String>>,
}

/// What a fix names in `unlinked_facts`: which unlinked conversation rows it targets.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConversationFix {
    #[default]
    Relink,
    Reextract,
    Manual,
}

/// `countUnlinkedFactsByOrigin(opts)`, `countUnlinkedFactStats(opts)` and
/// `listUnlinkedConversationSlugs(opts)`: the fields each reads.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlinkedQuery {
    pub source_ids: Vec<String>,
    pub source_id: String,
    pub audit_sources: Vec<String>,
    pub window_per_source: f64,
    pub fix: ConversationFix,
    pub has_attempts: bool,
    /// `REARMED` of facts/conversation-memo.ts: the relink reasons a newer page re-arms. The
    /// TypeScript member passes the list, so the two cannot drift.
    pub rearmed_reasons: Vec<String>,
}

/// `countFactEmbeddingCoverage(opts)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CoverageQuery {
    pub source_id: Option<String>,
    pub model: String,
    pub dims: f64,
}

/// Every fact row of every source, source by source. A fact names a source that exists, so this
/// is every row of the `facts` table.
fn every_fact(read: &dyn KvRead) -> Result<Vec<FactRecord>> {
    let mut out = Vec::new();
    for source in all_sources(read)? {
        out.extend(source_rows(read, &source.id)?);
    }
    Ok(out)
}

/// `s.config->>'kind'`.
fn source_kind(source: &SourceRecord) -> Option<String> {
    source.config.get("kind").and_then(jsonb_field_text)
}

/// The active-fact predicate of the unlinked-fact reads (`ACTIVE` in engine-sql/facts-doctor.ts):
/// not expired, not past `valid_until`, not an audit row of the list given, and a fact an entity
/// page can hold (`attributed_to` null or `user`).
fn active_unlinked(row: &FactRecord, now: i64, audit: &BTreeSet<&str>) -> bool {
    row.active(now)
        && !audit.contains(row.source.as_str())
        && row.attributed_to.as_deref().is_none_or(|who| who == "user")
}

/// `ORIGIN` of engine-sql/facts-doctor.ts: where an unlinked fact came from.
fn origin(row: &FactRecord) -> &'static str {
    let source = row.source.as_str();
    if row.conversation_slot() {
        "conversation"
    } else if source == "mcp:put_page" {
        "mcp:put_page"
    } else if ["mcp:", "sync:", "hook:"]
        .iter()
        .any(|p| source.starts_with(p))
        || source == "file_upload"
        || source == "code_import"
    {
        "extraction"
    } else {
        "remember"
    }
}

/// `LIMIT $n` over rows already ordered newest first (`created_at DESC`; ties by id, newest first).
fn newest_window(mut rows: Vec<FactRecord>, window: usize) -> Vec<FactRecord> {
    rows.sort_by(|a, b| b.created_at_us.cmp(&a.created_at_us).then(b.id.cmp(&a.id)));
    rows.truncate(window);
    rows
}

/// The attempts memos of the `hasAttempts` form, or `None` (every memo `false`) without it.
fn memos<'a>(read: &'a dyn KvRead, q: &'a UnlinkedQuery) -> Option<Memos<'a>> {
    q.has_attempts.then(|| Memos::new(read, &q.rearmed_reasons))
}

/// `texts` with each re-armed reason, for the NUL check.
fn with_rearmed<'a>(
    mut texts: Vec<(&'a str, &'a str)>,
    q: &'a UnlinkedQuery,
) -> Vec<(&'a str, &'a str)> {
    texts.extend(
        q.rearmed_reasons
            .iter()
            .map(|r| ("rearmedReasons", r.as_str())),
    );
    texts
}

/// The first `[a-z]+` run that follows an `entity inferred from ` in `text`:
/// `substring(text from 'entity inferred from ([a-z]+)')`.
fn inferred_tier(text: &str) -> Option<&str> {
    const MARK: &str = "entity inferred from ";
    let mut from = 0;
    while let Some(at) = text[from..].find(MARK) {
        let start = from + at + MARK.len();
        let run = text[start..]
            .bytes()
            .take_while(u8::is_ascii_lowercase)
            .count();
        if run > 0 {
            return Some(&text[start..start + run]);
        }
        from += at + 1;
    }
    None
}

impl Store {
    /// `listConversationFactRows(sourceIds, limit)`:
    /// `SELECT source_id, source_markdown_slug AS slug, context FROM facts WHERE source_id = ANY($1)
    /// AND source LIKE 'cli:extract-conversation-facts%' AND source = ANY($2) AND expired_at IS NULL
    /// ORDER BY id DESC LIMIT $3`, with `$2` the terminal and non-extractable audit sources
    /// (`AUDIT_ROW_SOURCES[0]` and `[1]`; the prefix test holds for both).
    pub fn list_conversation_fact_rows(&self, q: &ConversationRowsQuery) -> Result<Vec<Value>> {
        const OP: &str = "listConversationFactRows";
        let sources: BTreeSet<&str> = q.source_ids.iter().map(String::as_str).collect();
        let texts: Vec<(&str, &str)> = sources.iter().map(|s| ("sourceIds", *s)).collect();
        no_nul(OP, &texts)?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let read = self.read()?;
        let outcomes = [AUDIT_ROW_SOURCES[0], AUDIT_ROW_SOURCES[1]];
        let mut rows = Vec::new();
        for source in sources {
            for row in source_rows(&*read, source)? {
                if row.expired_at_us.is_none()
                    && row.conversation_slot()
                    && outcomes.contains(&row.source.as_str())
                {
                    rows.push(row);
                }
            }
        }
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        Ok(rows
            .iter()
            .take(limit)
            .map(|r| {
                json!({
                    "source_id": r.source_id,
                    "slug": r.source_markdown_slug,
                    "context": r.context,
                })
            })
            .collect())
    }

    /// `countRedactedFacts(sourceIds?)`: the active rows (`expired_at` and `superseded_by` null)
    /// whose text holds `[redacted`, in a source that is not archived (and, when ids are given,
    /// one of them; an empty list matches no source).
    pub fn count_redacted_facts(&self, q: &RedactedQuery) -> Result<u64> {
        const OP: &str = "countRedactedFacts";
        if let Some(ids) = &q.source_ids {
            let texts: Vec<(&str, &str)> = ids.iter().map(|s| ("sourceIds", s.as_str())).collect();
            no_nul(OP, &texts)?;
        }
        let read = self.read()?;
        let mut count = 0;
        for source in all_sources(&*read)? {
            let named = q
                .source_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&source.id));
            if source.archived || !named {
                continue;
            }
            for row in source_rows(&*read, &source.id)? {
                if row.expired_at_us.is_none()
                    && row.superseded_by.is_none()
                    && like(&row.fact, "%[redacted%", false)?
                {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    /// `listOutsideContentFenceCounts()`: for each live page of a live source that a third party
    /// wrote (a `google` source's `email` and `meeting` pages, any page of a `github` source, any
    /// page whose frontmatter has a top-level `transcript_import`), the fence rows indexed from it:
    /// facts (`row_num` set, unexpired, on the page named by `source_markdown_slug`; `world_facts`
    /// those with `visibility = 'world'`), active takes, and links with `origin_field =
    /// 'links_fence'` that name it as their origin. Rows come by source id then slug.
    pub fn list_outside_content_fence_counts(&self) -> Result<Vec<Value>> {
        #[derive(Default)]
        struct Counts {
            facts: u64,
            world: u64,
            takes: u64,
            links: u64,
        }
        let read = self.read()?;
        let mut by_page: BTreeMap<u64, Counts> = BTreeMap::new();
        for fact in every_fact(&*read)? {
            let (Some(_), None, Some(slug)) = (
                fact.row_num,
                fact.expired_at_us,
                fact.source_markdown_slug.as_deref(),
            ) else {
                continue;
            };
            if let Some(page) = read_page(&*read, &fact.source_id, slug)? {
                let c = by_page.entry(page.id).or_default();
                c.facts += 1;
                c.world += u64::from(fact.visibility == "world");
            }
        }
        for take in all_takes(&*read)? {
            if take.active {
                by_page.entry(take.page_id).or_default().takes += 1;
            }
        }
        for page in all_pages(&*read)? {
            for link in out_links(&*read, page.id)? {
                if let (Some(origin), Some("links_fence")) =
                    (link.origin_page_id, link.origin_field.as_deref())
                {
                    by_page.entry(origin).or_default().links += 1;
                }
            }
        }
        let sources: BTreeMap<String, SourceRecord> = all_sources(&*read)?
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();
        let mut rows = Vec::new();
        for (id, c) in by_page {
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            let Some(source) = sources.get(&page.source_id) else {
                continue;
            };
            if page.deleted_at_us.is_some() || source.archived {
                continue;
            }
            let kind = source_kind(source);
            let outside = (kind.as_deref() == Some("google")
                && ["email", "meeting"].contains(&page.page_type.as_str()))
                || kind.as_deref() == Some("github")
                || page.frontmatter.contains_key("transcript_import");
            if outside {
                rows.push((
                    page.source_id.clone(),
                    page.slug.clone(),
                    page.page_type.clone(),
                    c,
                ));
            }
        }
        rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        Ok(rows
            .into_iter()
            .map(|(source_id, slug, page_type, c)| {
                json!({
                    "source_id": source_id,
                    "slug": slug,
                    "type": page_type,
                    "facts": c.facts,
                    "world_facts": c.world,
                    "takes": c.takes,
                    "links": c.links,
                })
            })
            .collect())
    }

    /// `countAtomFacts()`: the unexpired rows, in every source, whose `source_markdown_slug` or
    /// `context` starts with `atoms/` (the pattern holds no wildcard but the trailing `%`).
    pub fn count_atom_facts(&self) -> Result<u64> {
        let read = self.read()?;
        let atom = |text: &Option<String>| text.as_deref().is_some_and(|t| t.starts_with("atoms/"));
        Ok(every_fact(&*read)?
            .iter()
            .filter(|r| {
                r.expired_at_us.is_none() && (atom(&r.source_markdown_slug) || atom(&r.context))
            })
            .count() as u64)
    }

    /// `countUnlinkedFactsByOrigin(opts)`: for each id of `sourceIds` (an id
    /// given twice counts twice, as the statement's `unnest` does), the source's newest
    /// `windowPerSource` active facts, counted by origin: `active`, `unlinked` (no entity),
    /// `fence_owned` (unlinked, a fence row or page, not conversation-derived), `conversation`
    /// (unlinked and derived), and `conversation_tried` / `conversation_paid`, the unlinked derived
    /// rows free relink tried, and of those the ones a paid re-extraction covers (both 0 without
    /// `hasAttempts`). Rows come by source id then origin.
    pub fn count_unlinked_facts_by_origin(&self, q: &UnlinkedQuery) -> Result<Vec<Value>> {
        const OP: &str = "countUnlinkedFactsByOrigin";
        let texts: Vec<(&str, &str)> = q
            .source_ids
            .iter()
            .map(|s| ("sourceIds", s.as_str()))
            .chain(q.audit_sources.iter().map(|s| ("auditSources", s.as_str())))
            .collect();
        no_nul(OP, &with_rearmed(texts, q))?;
        let window = count_arg(OP, "windowPerSource", q.window_per_source)?;
        let audit: BTreeSet<&str> = q.audit_sources.iter().map(String::as_str).collect();
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut memos = memos(&*read, q);
        // (active, unlinked, fence_owned, conversation, tried, paid) per (source, origin).
        let mut groups: BTreeMap<(String, &'static str), [u64; 6]> = BTreeMap::new();
        for id in &q.source_ids {
            let rows: Vec<FactRecord> = source_rows(&*read, id)?
                .into_iter()
                .filter(|r| active_unlinked(r, now, &audit))
                .collect();
            for row in newest_window(rows, window) {
                let unlinked = row.entity_slug.is_none();
                let derived = row.conversation_slot();
                let fence = row.row_num.is_some() || row.source_markdown_slug.is_some();
                let tried =
                    unlinked && derived && memos.as_mut().map_or(Ok(false), |m| m.tried(&row))?;
                let paid =
                    unlinked && derived && memos.as_mut().map_or(Ok(false), |m| m.paid(&row))?;
                let g = groups.entry((id.clone(), origin(&row))).or_default();
                g[0] += 1;
                g[1] += u64::from(unlinked);
                g[2] += u64::from(unlinked && fence && !derived);
                g[3] += u64::from(unlinked && derived);
                g[4] += u64::from(tried);
                g[5] += u64::from(tried && paid);
            }
        }
        Ok(groups
            .into_iter()
            .map(|((source_id, origin), g)| {
                json!({
                    "source_id": source_id,
                    "origin": origin,
                    "active": g[0],
                    "unlinked": g[1],
                    "fence_owned": g[2],
                    "conversation": g[3],
                    "conversation_tried": g[4],
                    "conversation_paid": g[5],
                })
            })
            .collect())
    }

    /// `countUnlinkedFactStats(opts)`: over the active facts of `sourceIds` created in the last 7
    /// days, `facts`, `unlinked`, `no_subject` (unlinked, the attempt's outcome `no_subject`) and
    /// `conversation_unresolved` (unlinked and tried; both 0 without `hasAttempts`), and `inferred_page` / `inferred_mention`, the facts whose
    /// `context` is `entity inferred from <tier>` (alone or after ` — `) with that tier.
    pub fn count_unlinked_fact_stats(&self, q: &UnlinkedQuery) -> Result<Value> {
        const OP: &str = "countUnlinkedFactStats";
        let texts: Vec<(&str, &str)> = q
            .source_ids
            .iter()
            .map(|s| ("sourceIds", s.as_str()))
            .chain(q.audit_sources.iter().map(|s| ("auditSources", s.as_str())))
            .collect();
        no_nul(OP, &with_rearmed(texts, q))?;
        let audit: BTreeSet<&str> = q.audit_sources.iter().map(String::as_str).collect();
        let sources: BTreeSet<&str> = q.source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let now = self.env.now_micros();
        let since = now - 7 * DAY_US;
        let mut memos = memos(&*read, q);
        let (mut facts, mut unlinked, mut page, mut mention) = (0u64, 0u64, 0u64, 0u64);
        let (mut no_subject, mut unresolved) = (0u64, 0u64);
        for source in sources {
            for row in source_rows(&*read, source)? {
                if row.created_at_us < since || !active_unlinked(&row, now, &audit) {
                    continue;
                }
                facts += 1;
                if row.entity_slug.is_none() {
                    unlinked += 1;
                    no_subject +=
                        u64::from(memos.as_ref().map_or(Ok(false), |m| m.no_subject(&row))?);
                    unresolved += u64::from(memos.as_mut().map_or(Ok(false), |m| m.tried(&row))?);
                }
                let inferred = match row.context.as_deref() {
                    Some(c) => {
                        like(c, "entity inferred from %", false)?
                            || like(c, "% — entity inferred from %", false)?
                    }
                    None => false,
                };
                if inferred {
                    match row.context.as_deref().and_then(inferred_tier) {
                        Some("page") => page += 1,
                        Some("mention") => mention += 1,
                        _ => {}
                    }
                }
            }
        }
        Ok(json!({
            "facts": facts,
            "unlinked": unlinked,
            "no_subject": no_subject,
            "conversation_unresolved": unresolved,
            "inferred_page": page,
            "inferred_mention": mention,
        }))
    }

    /// `listUnlinkedConversationSlugs(opts)`: in the newest `windowPerSource` active facts of one
    /// source, the pages (`source_markdown_slug`) holding unlinked conversation-derived rows that
    /// the fix targets, most rows first, then by slug: `relink` the rows not tried, `reextract` the
    /// tried ones not paid, `manual` the tried and paid ones. Without `hasAttempts` nothing is
    /// tried, so only `relink` targets rows.
    pub fn list_unlinked_conversation_slugs(&self, q: &UnlinkedQuery) -> Result<Vec<Value>> {
        const OP: &str = "listUnlinkedConversationSlugs";
        let texts: Vec<(&str, &str)> = std::iter::once(("sourceId", q.source_id.as_str()))
            .chain(q.audit_sources.iter().map(|s| ("auditSources", s.as_str())))
            .collect();
        no_nul(OP, &with_rearmed(texts, q))?;
        let window = count_arg(OP, "windowPerSource", q.window_per_source)?;
        let audit: BTreeSet<&str> = q.audit_sources.iter().map(String::as_str).collect();
        let read = self.read()?;
        let now = self.env.now_micros();
        let rows: Vec<FactRecord> = source_rows(&*read, &q.source_id)?
            .into_iter()
            .filter(|r| active_unlinked(r, now, &audit))
            .collect();
        let mut memos = memos(&*read, q);
        let mut pages: BTreeMap<String, u64> = BTreeMap::new();
        for row in newest_window(rows, window) {
            if row.entity_slug.is_some() || !row.conversation_slot() {
                continue;
            }
            let tried = memos.as_mut().map_or(Ok(false), |m| m.tried(&row))?;
            let hit = match q.fix {
                ConversationFix::Relink => !tried,
                ConversationFix::Reextract => {
                    tried && !memos.as_mut().map_or(Ok(false), |m| m.paid(&row))?
                }
                ConversationFix::Manual => {
                    tried && memos.as_mut().map_or(Ok(false), |m| m.paid(&row))?
                }
            };
            if let (true, Some(slug)) = (hit, row.source_markdown_slug) {
                *pages.entry(slug).or_default() += 1;
            }
        }
        let mut pages: Vec<(String, u64)> = pages.into_iter().collect();
        pages.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(pages
            .into_iter()
            .map(|(slug, _)| json!({ "slug": slug }))
            .collect())
    }

    /// `countFactEmbeddingCoverage(opts)`: for each source (only `sourceId` when given) with
    /// embeddable facts, `missing` (no vector), `stale` (no vector, a vector of another model or
    /// width, or `embedded_text_hash` other than `md5(fact)`) and `partial` (not stale, but longer
    /// than `EMBED_MAX_CHARS` UTF-16 units). A fact is embeddable when it is not expired or
    /// superseded, not past `valid_until`, not an audit row, in a source that exists and is not
    /// archived, its page (`source_markdown_slug`) is not soft-deleted, and it has no
    /// withdrawal of its claim (`eligibleFactEmbedding`: the row's source and visibility, either
    /// fingerprint, subject `*` or the row's entity, or only the page's own subject on a member
    /// page). Rows come by source id.
    pub fn count_fact_embedding_coverage(&self, q: &CoverageQuery) -> Result<Vec<Value>> {
        let mut groups: BTreeMap<String, [u64; 3]> = BTreeMap::new();
        self.for_each_embeddable_fact("countFactEmbeddingCoverage", q, &mut |row, stale| {
            let missing = row.embedding.is_none();
            let partial = !stale
                && row.fact.len() > EMBED_MAX_CHARS
                && row.fact.encode_utf16().count() > EMBED_MAX_CHARS;
            let g = groups.entry(row.source_id.clone()).or_default();
            g[0] += u64::from(missing);
            g[1] += u64::from(stale);
            g[2] += u64::from(partial);
        })?;
        Ok(groups
            .into_iter()
            .map(|(source_id, g)| {
                json!({ "source_id": source_id, "missing": g[0], "stale": g[1], "partial": g[2] })
            })
            .collect())
    }

    /// `countStaleFactEmbeddings({ model, dims, sourceId? })`: `{ count, chars }` of the
    /// embeddable facts whose vector is not current for `model` and `dims` (the `stale` count of
    /// `countFactEmbeddingCoverage`, over every source or one). `chars` sums each stale fact's
    /// length in characters (Postgres `length(fact)`, code points).
    pub fn count_stale_fact_embeddings(&self, q: &CoverageQuery) -> Result<Value> {
        let (mut count, mut chars) = (0u64, 0u64);
        self.for_each_embeddable_fact("countStaleFactEmbeddings", q, &mut |row, stale| {
            if stale {
                count += 1;
                chars += row.fact.chars().count() as u64;
            }
        })?;
        Ok(json!({ "count": count, "chars": chars }))
    }

    /// Calls `f` with every embeddable fact of `q`'s sources and whether its vector is stale for
    /// `q.model` and `q.dims`. Embeddable is `eligibleFactEmbedding`: the fact is not expired,
    /// superseded, past `valid_until` or an audit row, its source is not archived, and its page
    /// (`source_markdown_slug`) is not soft-deleted. The store keeps no `fact_withdrawals` (the
    /// Rust engine refuses `executeRaw`, their only writer), so none hides a fact.
    fn for_each_embeddable_fact(
        &self,
        op: &str,
        q: &CoverageQuery,
        f: &mut dyn FnMut(&FactRecord, bool),
    ) -> Result<()> {
        let texts: Vec<(&str, &str)> = std::iter::once(("model", q.model.as_str()))
            .chain(q.source_id.as_deref().map(|s| ("sourceId", s)))
            .collect();
        no_nul(op, &texts)?;
        if !q.dims.is_finite() || q.dims.fract() != 0.0 || q.dims.abs() > f64::from(i32::MAX) {
            return Err(StoreError::invalid(format!(
                "{op}: invalid input syntax for type integer: \"{}\" (dims)",
                q.dims
            )));
        }
        let dims = q.dims as i64;
        let read = self.read()?;
        let now = self.env.now_micros();
        let sources: Vec<SourceRecord> = match &q.source_id {
            Some(id) => read_source(&*read, id)?.into_iter().collect(),
            None => all_sources(&*read)?,
        };
        for source in sources.iter().filter(|s| !s.archived) {
            for row in source_rows(&*read, &source.id)? {
                if row.expired_at_us.is_some()
                    || row.superseded_by.is_some()
                    || row.valid_until_us.is_some_and(|until| until <= now)
                    || AUDIT_ROW_SOURCES.contains(&row.source.as_str())
                {
                    continue;
                }
                if let Some(slug) = row.source_markdown_slug.as_deref()
                    && read_page(&*read, &row.source_id, slug)?
                        .is_some_and(|p| p.deleted_at_us.is_some())
                {
                    continue;
                }
                if withdrawn_for_embedding(&*read, &row)? {
                    continue;
                }
                let stale = row.embedding.is_none()
                    || row.embedding_model.as_deref() != Some(q.model.as_str())
                    || row.embedded_text_hash.as_deref() != Some(md5_hex(&row.fact).as_str())
                    || row.embedding.as_ref().map(|v| v.len() as i64) != Some(dims);
                f(&row, stale);
            }
        }
        Ok(())
    }
}
/// `eligibleFactEmbedding`'s withdrawal anti-join: a withdrawal of the row's claim (either fingerprint) in its source and
/// visibility whose subject is `*` or the row's entity, or, on a member page (`memory/members/..`), the page's own slug.
/// It is narrower than the write-time guard: an unbacked name key gets no extra subjects here.
fn withdrawn_for_embedding(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let member = row
        .source_markdown_slug
        .as_deref()
        .filter(|s| s.starts_with("memory/members/"));
    Ok(
        crate::trust::withdrawals::withdrawals_of(
            read,
            &row.source_id,
            &row.visibility,
            &row.fact,
        )?
        .iter()
        .any(|(subject, _)| match member {
            Some(slug) => subject == slug,
            None => subject == "*" || row.entity_slug.as_deref() == Some(subject.as_str()),
        }),
    )
}
