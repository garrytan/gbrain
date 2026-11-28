//! Entity and mention reads the CLI made through `executeRaw` (`src/core/engine-sql/entity-reads.ts`).
//!
//! The mention-pass reads use the pass's state (`mention_state.rs`): the status rows' pass times and
//! each page's mention and alias state.
//! Frontmatter values are read as PostgreSQL's `->>` reads them (see [`arrow_text`]).

use crate::Store;
use crate::access_rules::stamped;
use crate::chunks::SAFE_FENCE_CHUNKER_VERSION;
use crate::cli_reads::pg_text::{pg_lower, regex_char_matches};
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, like, page_hidden};
use crate::kv::KvRead;
use crate::link_queries::ranks;
use crate::links::out_links;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// The frontmatter keys whose values gbrain reads as privacy labels (`PRIVACY_LABEL_KEYS`).
const PRIVACY_LABEL_KEYS: &[&str] = &["access", "confidentiality"];
/// The frontmatter key that marks a quarantined page (`QUARANTINE_KEY`).
const QUARANTINE_KEY: &str = "quarantine";

/// `readMentionIndexStatus(sourceIds)`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionIndexStatusQuery {
    pub source_ids: Vec<String>,
}

/// One `mention_index_status` row as `readMentionIndexStatus` returns it. The store writes none.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MentionIndexStatusRow {
    pub source_id: String,
    pub state: String,
    pub pending: i64,
    pub counted_at: Option<String>,
    pub last_pass_at: Option<String>,
    pub policy_fingerprint: Option<String>,
}

/// `countMentionDueSince(sourceId, since, mentionVersion)`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionDueSinceQuery {
    pub source_id: String,
    /// A `timestamptz` text, or `-infinity` for no lower bound.
    pub since: String,
    /// The extractor version a page's state must hold to count as scanned.
    #[serde(default)]
    pub mention_version: i64,
}

/// `recountMentionIndexStatus(sourceId, recount)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionIndexRecount {
    pub source_id: String,
    pub pending: i64,
    pub fingerprint: String,
    pub expected_fingerprint: Option<String>,
}

/// `countPagesDueForMentions(q)`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionDueQuery {
    #[serde(default)]
    pub source_id: Option<String>,
    /// The extractor version a page's mention state must carry to be current.
    #[serde(default)]
    pub mention_version: i64,
    /// Also count pages of these types whose derived aliases are behind their content or `version`.
    #[serde(default)]
    pub aliases: Option<MentionDueAliases>,
}

/// `MentionDueQuery.aliases`.
#[derive(Debug, Default, Deserialize)]
pub struct MentionDueAliases {
    pub types: Vec<String>,
    pub version: i64,
}

/// `readIdentitySiblingCandidates(sourceId, q)`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiblingCandidateQuery {
    pub types: Vec<String>,
    pub subject: String,
    pub limit: u64,
    #[serde(default)]
    pub exclude_quarantined: bool,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    #[serde(default)]
    pub exclude_private: Option<PrivacyPolicy>,
}

/// One sibling candidate: `identity` is the frontmatter value as `->>` reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SiblingCandidateRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub identity: Option<String>,
}

/// One retirement hop (`readRetirementHop`): the page, whether it is retired (`retiredPageSql`),
/// and its trimmed `superseded_by`, else `merged_into`, value as the redirect target.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetirementHopRow {
    pub slug: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub retired: bool,
    pub target: Option<String>,
}

/// `readEntityCardRows` match: the name arm (`lower(title) = title_lc OR slug = ANY(slugs) OR slug
/// LIKE slug_like`) or the hydrate arm (`slug = ANY(slugs)`).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum EntityCardMatch {
    Name {
        #[serde(rename = "titleLc")]
        title_lc: String,
        slugs: Vec<String>,
        #[serde(rename = "slugLike")]
        slug_like: String,
    },
    Slugs {
        slugs: Vec<String>,
    },
}

/// One entity-card candidate row (`readEntityCardRows`). `compiled_truth` is the bounded body
/// prefix, `left(coalesce(compiled_truth, truth_lead), 65536)`. `last_retrieved_at` is the page's
/// retrieval record (`page_ops/retrievals.rs`, written by bumpPageRetrievals), the `page_retrievals`
/// half of the SQL `GREATEST(...)`; the store keeps no legacy `pages.last_retrieved_at` column.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EntityCardRow {
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Value,
    pub compiled_truth: Option<String>,
    pub updated_at: String,
    pub last_retrieved_at: Option<String>,
}

/// `left(coalesce(compiled_truth, truth_lead), BOUNDED_PREFIX_BYTES)`; `left()` counts code points.
const CARD_PREFIX_CHARS: usize = 64 * 1024;

/// `boundedBodyPrefixSql`: `left(coalesce(compiled_truth, truth_lead), 65536)`, the first 64K
/// characters of the page body (the stored body, else its truth lead).
pub(crate) fn bounded_body_prefix(
    read: &dyn crate::kv::KvRead,
    p: &PageRecord,
) -> Result<Option<String>> {
    let body = match p.compiled_truth.as_deref() {
        Some(text) => Some(text.to_string()),
        None => crate::page_body::truth_lead(read, p.id)?,
    };
    Ok(body.map(|b| {
        b.char_indices()
            .nth(CARD_PREFIX_CHARS)
            .map_or(b.clone(), |(at, _)| b[..at].to_string())
    }))
}

/// `readIgnoredPrivacyLabelPages` scope: the run's own slugs, or pages updated since an ISO time.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum LabelScope {
    Slugs { slugs: Vec<String> },
    Since { since: String },
}

/// The pages `readEntityAnchoredPages` answers besides the entity page (`ENTITY_ANCHORED_LIMIT`).
const ENTITY_ANCHORED_LIMIT: usize = 10;
/// The frontmatter key of a pinned question page (`PINNED_QUESTION_MARKER`).
const PINNED_QUESTION_KEY: &str = "pinned_question";

/// The live entity page `readEntityAnchoredPages` found: its id and title.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnchorEntity {
    pub id: u64,
    pub title: String,
}

/// One anchored page: its id and slug.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnchoredPageRow {
    pub id: u64,
    pub slug: String,
}

/// `readEntityAnchoredPages(sourceId, entitySlug)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EntityAnchoredPages {
    pub entity: Option<AnchorEntity>,
    pub pages: Vec<AnchoredPageRow>,
}

/// `readImageSealProbe(sourceId, slug)`: whether a sealed image page holds an image vector.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageSealProbeRow {
    pub has_visual: bool,
}

/// `readPageChunkerVersion(pageId)`: the stored chunker version of one page record.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChunkerVersionRow {
    pub chunker_version: Option<i16>,
}

/// One `readPageTitlesById` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageTitleRow {
    pub id: u64,
    pub title: String,
}

/// One page a text-mention probe lists; `date` is `COALESCE(effective_date, updated_at)` as ISO text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextMentionPageRow {
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Map<String, Value>,
    pub date: String,
}

/// One labelled page: its type and frontmatter.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LabelPageRow {
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Map<String, Value>,
}

/// One unretired page a slug pattern matched (`listUnretiredPagesBySlugPattern`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlugPatternPageRow {
    pub slug: String,
    pub title: String,
}

/// `listNameVariantCandidates(sourceId, q)`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameVariantCandidateQuery {
    pub types: Vec<String>,
    pub slug_patterns: Vec<String>,
    pub probes: Vec<String>,
    pub limit: u64,
}

/// One name-variant candidate: `probe_hits` is the number of probes its title or slug matches.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NameVariantCandidateRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Map<String, Value>,
    pub probe_hits: u64,
}

/// One name-variant candidate as an entity-card row (`listNameVariantCardCandidates`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NameVariantCardCandidateRow {
    #[serde(flatten)]
    pub card: EntityCardRow,
    pub probe_hits: u64,
}

/// One name-variant page row (`readVisibleVariantPages`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VariantPageRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Map<String, Value>,
}

/// The distinct pages linking to one page (`countDistinctInboundLinkers`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InboundLinkerCountRow {
    pub source_id: String,
    pub slug: String,
    pub n: u64,
}

impl Store {
    /// `readMentionLastPass(sourceId?)`: the newest pass time over every source or one source, ISO
    /// UTC in whole seconds (`to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` truncates); `None` when no
    /// pass ran.
    pub fn read_mention_last_pass(&self, source_id: Option<&str>) -> Result<Option<String>> {
        let read = self.read()?;
        let last = crate::mention_state::all_statuses(&*read)?
            .into_iter()
            .filter(|(s, _)| source_id.is_none_or(|want| s == want))
            .filter_map(|(_, r)| r.last_pass_at_us)
            .max();
        Ok(last.map(|us| {
            let text = iso(us);
            format!("{}Z", text.split('.').next().unwrap_or(&text))
        }))
    }

    /// `readMentionIndexStatus(sourceIds)`: the status rows of those sources (the pass's state,
    /// `mention_state.rs`), in source byte order; a source the pass never ran on has no row.
    pub fn read_mention_index_status(
        &self,
        q: &MentionIndexStatusQuery,
    ) -> Result<Vec<MentionIndexStatusRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for (source_id, r) in crate::mention_state::all_statuses(&*read)? {
            if !q.source_ids.contains(&source_id) {
                continue;
            }
            out.push(MentionIndexStatusRow {
                source_id,
                state: r.state,
                pending: r.pending,
                counted_at: r.counted_at_us.map(iso),
                last_pass_at: r.last_pass_at_us.map(iso),
                policy_fingerprint: r.policy_fingerprint,
            });
        }
        Ok(out)
    }

    /// `countMentionDueSince(sourceId, since, mentionVersion)`: the source's live pages with
    /// `updated_at >= since` and no mention state at the page's content and `mention_version`.
    /// `-infinity` has no bound; `infinity` matches nothing; other text must be the ISO time
    /// coverage passes (`toIso`), or the read is refused.
    pub fn count_mention_due_since(&self, q: &MentionDueSinceQuery) -> Result<u64> {
        let since = match q.since.trim() {
            "-infinity" => i64::MIN,
            "infinity" => return Ok(0),
            text => parse_iso(text).ok_or_else(|| {
                StoreError::invalid(format!(
                    "countMentionDueSince: since is not an ISO time: {text:?}"
                ))
            })?,
        };
        let read = self.read()?;
        let mut n = 0u64;
        for p in all_pages(&*read)? {
            if p.deleted_at_us.is_some() || p.source_id != q.source_id || p.updated_at_us < since {
                continue;
            }
            let state = crate::mention_state::read_page_state(&*read, p.id)?;
            if crate::mention_state::mention_due(state.as_ref(), &p, q.mention_version) {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `recountMentionIndexStatus(sourceId, recount)`: saves the recount on the source's status
    /// row (pending, counted_at, the fingerprint; `complete` becomes `pending` above 0) while its
    /// fingerprint is still `expected_fingerprint`; a source with no row is untouched.
    pub fn recount_mention_index_status(&self, q: &MentionIndexRecount) -> Result<()> {
        let now = crate::env::transaction_clock::transaction_now()
            .unwrap_or_else(|| self.env.now_micros());
        self.write(|tx| {
            let Some(mut row) = crate::mention_state::read_status(&*tx, &q.source_id)? else {
                return Ok(());
            };
            if row.policy_fingerprint != q.expected_fingerprint {
                return Ok(());
            }
            row.pending = q.pending;
            row.counted_at_us = Some(now);
            row.policy_fingerprint = Some(q.fingerprint.clone());
            row.updated_at_us = now;
            if row.state == "complete" && q.pending > 0 {
                row.state = "pending".to_string();
            }
            crate::mention_state::put_status(tx, &q.source_id, &row)
        })
    }

    /// `countPagesDueForMentions(q)`: the live pages in the scope (every page when `source_id` is
    /// `None`) with no mention state or state behind the page's content or `mention_version`; with
    /// `aliases`, also the pages of its types whose derived aliases are behind.
    pub fn count_pages_due_for_mentions(&self, q: &MentionDueQuery) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0u64;
        for p in all_pages(&*read)? {
            if p.deleted_at_us.is_some() || q.source_id.as_deref().is_some_and(|s| p.source_id != s)
            {
                continue;
            }
            let state = crate::mention_state::read_page_state(&*read, p.id)?;
            let due = crate::mention_state::mention_due(state.as_ref(), &p, q.mention_version)
                || q.aliases.as_ref().is_some_and(|a| {
                    a.types.contains(&p.page_type)
                        && crate::mention_state::alias_due(state.as_ref(), &p, a.version)
                });
            if due {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `readIdentitySiblingCandidates(sourceId, q)`: live pages of the source whose type is one of
    /// `types` and whose lowercased title is `subject` or ends in `": " + subject`, by slug, at most
    /// `limit`. `exclude_quarantined` leaves out pages whose frontmatter has a `quarantine` key, and
    /// `exclude_private` the pages the page policy hides.
    pub fn read_identity_sibling_candidates(
        &self,
        source_id: &str,
        q: &SiblingCandidateQuery,
    ) -> Result<Vec<SiblingCandidateRow>> {
        let read = self.read()?;
        let suffix = format!(": {}", q.subject);
        let mut rows = Vec::new();
        for p in all_pages(&*read)? {
            let title = p.title.to_lowercase();
            if p.source_id != source_id
                || p.deleted_at_us.is_some()
                || !q.types.contains(&p.page_type)
                || (q.exclude_quarantined && p.frontmatter.contains_key(QUARANTINE_KEY))
                || !(title == q.subject || title.ends_with(&suffix))
            {
                continue;
            }
            if let Some(policy) = &q.exclude_private
                && page_hidden(&*read, &p, policy)?
            {
                continue;
            }
            rows.push(SiblingCandidateRow {
                identity: p.frontmatter.get("identity").and_then(arrow_text),
                slug: p.slug,
                title: p.title,
                page_type: p.page_type,
            });
        }
        rows.sort_by(|a, b| a.slug.cmp(&b.slug));
        rows.truncate(usize::try_from(q.limit).unwrap_or(usize::MAX));
        Ok(rows)
    }

    /// `readSiblingGroupRows(sourceId, slugs, { excludePrivate })`: the live pages of the source at
    /// `slugs`, each once, in list order (the SQL sets none), with frontmatter `identity` as `->>`
    /// reads it; `exclude_private` leaves out the pages the page policy hides.
    pub fn read_sibling_group_rows(
        &self,
        source_id: &str,
        slugs: &[String],
        exclude_private: Option<&PrivacyPolicy>,
    ) -> Result<Vec<SiblingCandidateRow>> {
        let read = self.read()?;
        let mut seen = std::collections::BTreeSet::new();
        let mut rows = Vec::new();
        for slug in slugs {
            if !seen.insert(slug.as_str()) {
                continue;
            }
            let Some(p) = crate::pages::read_page(&*read, source_id, slug)?
                .filter(|p| p.deleted_at_us.is_none())
            else {
                continue;
            };
            if let Some(policy) = exclude_private
                && page_hidden(&*read, &p, policy)?
            {
                continue;
            }
            rows.push(SiblingCandidateRow {
                identity: p.frontmatter.get("identity").and_then(arrow_text),
                slug: p.slug,
                title: p.title,
                page_type: p.page_type,
            });
        }
        Ok(rows)
    }

    /// `findExactSlug(sourceId, slugs, { retired })`: the first of `slugs` at which a live page
    /// sits and is (`Some(true)`), is not (`Some(false)`) or is either (`None`) a retired page
    /// (`retiredPageSql`); `None` otherwise.
    pub fn find_exact_slug(
        &self,
        source_id: &str,
        slugs: &[String],
        retired: Option<bool>,
    ) -> Result<Option<String>> {
        let read = self.read()?;
        for slug in slugs {
            let page = crate::pages::read_page(&*read, source_id, slug)?;
            if let Some(p) = page.filter(|p| {
                p.deleted_at_us.is_none() && retired.is_none_or(|want| is_retired(p) == want)
            }) {
                return Ok(Some(p.slug));
            }
        }
        Ok(None)
    }

    /// `findExactBasenameCandidates(sourceId, slugs)`: at most two of `slugs` at which a live page
    /// sits, in slug byte order. Postgres reads them with `LIMIT 2` and no `ORDER BY`, so when more
    /// than two match, the two it returns can differ from these.
    pub fn find_exact_basename_candidates(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<String>> {
        let wanted: BTreeSet<&String> = slugs.iter().collect();
        let read = self.read()?;
        let mut found = Vec::new();
        for slug in wanted {
            let page = crate::pages::read_page(&*read, source_id, slug)?;
            if let Some(p) = page.filter(|p| p.deleted_at_us.is_none()) {
                found.push(p.slug);
                if found.len() == 2 {
                    break;
                }
            }
        }
        Ok(found)
    }

    /// `readRetirementHop(sourceId, slug, privacy)`: the live page at `slug` in the source with its
    /// retirement and redirect target, or `None` when no live page sits there or `policy` hides it
    /// (`page_hidden`). `None` policy reads every page.
    pub fn read_retirement_hop(
        &self,
        source_id: &str,
        slug: &str,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Option<RetirementHopRow>> {
        let read = self.read()?;
        let Some(p) =
            crate::pages::read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(None);
        };
        if let Some(policy) = policy
            && page_hidden(&*read, &p, policy)?
        {
            return Ok(None);
        }
        // `NULLIF(btrim(x), '')`: btrim trims spaces only.
        let target = |key: &str| {
            p.frontmatter
                .get(key)
                .and_then(arrow_text)
                .map(|v| v.trim_matches(' ').to_string())
                .filter(|v| !v.is_empty())
        };
        Ok(Some(RetirementHopRow {
            retired: is_retired(&p),
            target: target("superseded_by").or_else(|| target("merged_into")),
            slug: p.slug.clone(),
            page_type: p.page_type.clone(),
        }))
    }

    /// `readEntityCardRows(sourceId, match, policy)`: the live pages of the source the match names,
    /// with the bounded body prefix, that the page policy (when given) does not hide. No order.
    pub fn read_entity_card_rows(
        &self,
        source_id: &str,
        matcher: &EntityCardMatch,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<EntityCardRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for p in all_pages(&*read)? {
            if p.source_id != source_id || p.deleted_at_us.is_some() {
                continue;
            }
            let hit = match matcher {
                EntityCardMatch::Name {
                    title_lc,
                    slugs,
                    slug_like,
                } => {
                    pg_lower(&p.title) == *title_lc
                        || slugs.contains(&p.slug)
                        || like(&p.slug, slug_like, false)?
                }
                EntityCardMatch::Slugs { slugs } => slugs.contains(&p.slug),
            };
            if !hit {
                continue;
            }
            if let Some(policy) = policy
                && page_hidden(&*read, &p, policy)?
            {
                continue;
            }
            out.push(card_row(&*read, p)?);
        }
        Ok(out)
    }

    /// `readIgnoredPrivacyLabelPages(sourceId, scope)`: the live pages of the source in the scope
    /// that carry a privacy label key, no `readable_by` and no folder rule (`folder_rule_ids IS
    /// NULL`, [`stamped`]). The caller applies the label rule
    /// (`ignoredPrivacyLabels`) and the limit.
    pub fn read_ignored_privacy_label_pages(
        &self,
        source_id: &str,
        scope: &LabelScope,
    ) -> Result<Vec<LabelPageRow>> {
        let in_scope: Box<dyn Fn(&PageRecord) -> bool> = match scope {
            LabelScope::Slugs { slugs } => {
                let set: BTreeSet<String> = slugs.iter().cloned().collect();
                Box::new(move |p| set.contains(&p.slug))
            }
            LabelScope::Since { since } => {
                let since_us = parse_iso(since).ok_or_else(|| {
                    StoreError::invalid(format!(
                        "invalid input syntax for type timestamp with time zone: \"{since}\""
                    ))
                })?;
                Box::new(move |p| p.updated_at_us >= since_us)
            }
        };
        let read = self.read()?;
        let mut rows = Vec::new();
        for p in all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none() && in_scope(p))
            .filter(|p| !p.frontmatter.contains_key("readable_by"))
            .filter(|p| {
                PRIVACY_LABEL_KEYS
                    .iter()
                    .any(|k| p.frontmatter.contains_key(*k))
            })
        {
            // `p.folder_rule_ids IS NULL`: a page a folder rule covers is not an unprotected label.
            if stamped(&*read, &p.source_id, &p.slug)? {
                continue;
            }
            rows.push(LabelPageRow {
                page_type: p.page_type,
                frontmatter: p.frontmatter,
            });
        }
        Ok(rows)
    }

    /// `listUnretiredPagesBySlugPattern(sourceId, patterns, limit)`: the live, unretired pages of the
    /// source whose slug matches one of `patterns` (LIKE), by slug, at most `limit`.
    pub fn list_unretired_pages_by_slug_pattern(
        &self,
        source_id: &str,
        patterns: &[String],
        limit: u64,
    ) -> Result<Vec<SlugPatternPageRow>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for p in all_pages(&*read)? {
            if p.source_id != source_id || p.deleted_at_us.is_some() || is_retired(&p) {
                continue;
            }
            if any_like(&p.slug, patterns, false)? {
                rows.push(SlugPatternPageRow {
                    slug: p.slug,
                    title: p.title,
                });
            }
        }
        rows.sort_by(|a, b| a.slug.cmp(&b.slug));
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(rows)
    }

    /// `listNameVariantCandidates(sourceId, q)`: the live pages of the source whose type is one of
    /// `types` or whose slug matches one of `slug_patterns` (LIKE), and whose title or slug matches a
    /// probe (ILIKE). Most probe hits first, then the shortest title, then slug; at most `limit`.
    pub fn list_name_variant_candidates(
        &self,
        source_id: &str,
        q: &NameVariantCandidateQuery,
    ) -> Result<Vec<NameVariantCandidateRow>> {
        self.list_visible_name_variant_candidates(source_id, q, None)
    }

    /// `listVisibleNameVariantCandidates(sourceId, q, policy)`: `listNameVariantCandidates` with the
    /// page policy (`page_hidden`) applied before the limit; a `None` policy reads every page.
    pub fn list_visible_name_variant_candidates(
        &self,
        source_id: &str,
        q: &NameVariantCandidateQuery,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<NameVariantCandidateRow>> {
        let read = self.read()?;
        Ok(name_variant_pages(&*read, source_id, q, policy)?
            .into_iter()
            .map(|(p, hits)| NameVariantCandidateRow {
                slug: p.slug,
                title: p.title,
                page_type: p.page_type,
                frontmatter: p.frontmatter,
                probe_hits: hits,
            })
            .collect())
    }

    /// `listNameVariantCardCandidates(sourceId, q, policy)`: the candidates
    /// `listVisibleNameVariantCandidates` reads, in the same order and under the same page policy,
    /// as entity-card rows (`readEntityCardRows`) with their `probe_hits`.
    pub fn list_name_variant_card_candidates(
        &self,
        source_id: &str,
        q: &NameVariantCandidateQuery,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<NameVariantCardCandidateRow>> {
        let read = self.read()?;
        name_variant_pages(&*read, source_id, q, policy)?
            .into_iter()
            .map(|(p, probe_hits)| {
                Ok(NameVariantCardCandidateRow {
                    card: card_row(&*read, p)?,
                    probe_hits,
                })
            })
            .collect()
    }

    /// `readVisibleVariantPages(sourceId, slugs, policy)`: the live page of the source at each of
    /// `slugs`, in `slugs` order (a repeated slug reads once per mention), skipping a slug with no
    /// live page and, under a policy, a page `page_hidden` hides.
    pub fn read_visible_variant_pages(
        &self,
        source_id: &str,
        slugs: &[String],
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<VariantPageRow>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for slug in slugs {
            let Some(p) = crate::pages::read_page(&*read, source_id, slug)?
                .filter(|p| p.deleted_at_us.is_none())
            else {
                continue;
            };
            if let Some(policy) = policy
                && page_hidden(&*read, &p, policy)?
            {
                continue;
            }
            rows.push(VariantPageRow {
                slug: p.slug,
                title: p.title,
                page_type: p.page_type,
                frontmatter: p.frontmatter,
            });
        }
        Ok(rows)
    }

    /// `countDistinctInboundLinkers(sourceIds, slugs)`: for each page at (`source_ids[i]`,
    /// `slugs[i]`), deleted or not, the number of distinct pages linking to it by any link kind.
    /// Pages with no inbound link, and pairs with no page, are absent.
    pub fn count_distinct_inbound_linkers(
        &self,
        source_ids: &[String],
        slugs: &[String],
    ) -> Result<Vec<InboundLinkerCountRow>> {
        let read = self.read()?;
        let pairs: BTreeSet<(&str, &str)> = source_ids
            .iter()
            .zip(slugs)
            .map(|(s, slug)| (s.as_str(), slug.as_str()))
            .collect();
        let mut rows = Vec::new();
        for (source_id, slug) in pairs {
            let Some(p) = crate::pages::read_page(&*read, source_id, slug)? else {
                continue;
            };
            let linkers: BTreeSet<u64> = crate::links::in_links(&*read, p.id)?
                .iter()
                .map(|l| l.from_page_id)
                .collect();
            if !linkers.is_empty() {
                rows.push(InboundLinkerCountRow {
                    source_id: p.source_id,
                    slug: p.slug,
                    n: linkers.len() as u64,
                });
            }
        }
        Ok(rows)
    }

    /// `readLivePageFrontmatter(sourceId, slug)`: the type and frontmatter of the live page at the
    /// slug in the source, or `None` when no live page sits there.
    pub fn read_live_page_frontmatter(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Option<LabelPageRow>> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .into_iter()
            .find(|p| p.source_id == source_id && p.slug == slug && p.deleted_at_us.is_none())
            .map(|p| LabelPageRow {
                page_type: p.page_type,
                frontmatter: p.frontmatter,
            }))
    }

    /// `readEntityAnchoredPages(sourceId, entitySlug)`: the live entity page at the slug, then up to
    /// ten other live pages of the source (no question, synthesis or pinned-question page) whose
    /// compiled truth names the entity as a word (`~* '\m(name|...)\M'`, see [`names_as_word`]) or
    /// that link to the entity page by a ranking link, by `COALESCE(effective_date, updated_at)`
    /// newest first, then by id descending.
    pub fn read_entity_anchored_pages(
        &self,
        source_id: &str,
        entity_slug: &str,
    ) -> Result<EntityAnchoredPages> {
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let entity = pages.iter().find(|p| {
            p.source_id == source_id && p.slug == entity_slug && p.deleted_at_us.is_none()
        });
        let mut names: Vec<Vec<char>> = Vec::new();
        let tail = entity_slug.rsplit('/').next().unwrap_or(entity_slug);
        let title = entity.map(|e| e.title.as_str()).filter(|t| !t.is_empty());
        for name in std::iter::once(tail).chain(title) {
            let chars: Vec<char> = name.chars().collect();
            if name.encode_utf16().count() >= 3 && !names.contains(&chars) {
                names.push(chars);
            }
        }
        let mut hits: Vec<&PageRecord> = Vec::new();
        for p in &pages {
            if p.source_id != source_id
                || p.deleted_at_us.is_some()
                || p.slug == entity_slug
                || p.page_type == "question"
                || p.page_type == "synthesis"
                || p.frontmatter.contains_key(PINNED_QUESTION_KEY)
            {
                continue;
            }
            let named = p
                .compiled_truth
                .as_deref()
                .is_some_and(|text| names_as_word(text, &names));
            let linked = match entity {
                Some(e) if !named => out_links(&*read, p.id)?
                    .iter()
                    .any(|l| l.to_page_id == e.id && ranks(l)),
                _ => false,
            };
            if named || linked {
                hits.push(p);
            }
        }
        hits.sort_by(|a, b| {
            let date = |p: &PageRecord| p.effective_date_us.unwrap_or(p.updated_at_us);
            date(b).cmp(&date(a)).then(b.id.cmp(&a.id))
        });
        Ok(EntityAnchoredPages {
            entity: entity.map(|e| AnchorEntity {
                id: e.id,
                title: e.title.clone(),
            }),
            pages: hits
                .into_iter()
                .take(ENTITY_ANCHORED_LIMIT)
                .map(|p| AnchoredPageRow {
                    id: p.id,
                    slug: p.slug.clone(),
                })
                .collect(),
        })
    }

    /// `readPageTitlesById(ids)`: the title of each page id, deleted or not, each once. An id
    /// outside `integer` is refused, as the `$1::int[]` cast refuses it.
    pub fn read_page_titles_by_id(&self, ids: &[i64]) -> Result<Vec<PageTitleRow>> {
        let mut wanted = BTreeSet::new();
        for &id in ids {
            if i32::try_from(id).is_err() {
                return Err(StoreError::invalid(format!(
                    "readPageTitlesById id {id} is out of range for type integer"
                )));
            }
            // Page ids start at 1, so a zero or negative id names no page.
            if id > 0 {
                wanted.insert(id as u64);
            }
        }
        let read = self.read()?;
        let mut rows = Vec::new();
        for id in wanted {
            if let Some(p) = read_page_by_id(&*read, id)? {
                rows.push(PageTitleRow { id, title: p.title });
            }
        }
        Ok(rows)
    }

    /// `readImageSealProbe(sourceId, slug)`: `{ has_visual }` when the page record at the slug
    /// (live or soft-deleted) is sealed past the safe-chunk fence (`chunker_version >= 4`; a record
    /// with no version reads as below it), else `None`. The store keeps no image vector, so
    /// `has_visual` is always false, as `sealImagePages` answers.
    pub fn read_image_seal_probe(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Option<ImageSealProbeRow>> {
        let read = self.read()?;
        Ok(crate::pages::read_page(&*read, source_id, slug)?
            .filter(|p| p.chunker_version.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION)
            .map(|_| ImageSealProbeRow { has_visual: false }))
    }

    /// `readPageChunkerVersion(pageId)`: `{ chunker_version }` of the page record with the id, live,
    /// soft-deleted or segmented, or `None` when no record has it. An id outside `integer` is
    /// refused, as the `id = $1` comparison refuses it. A record written before the store kept a
    /// chunker version answers `null`, as SQL reads a NULL column.
    pub fn read_page_chunker_version(&self, page_id: i64) -> Result<Option<ChunkerVersionRow>> {
        if i32::try_from(page_id).is_err() {
            return Err(StoreError::invalid(format!(
                "readPageChunkerVersion id {page_id} is out of range for type integer"
            )));
        }
        // Page ids start at 1, so a zero or negative id names no page.
        if page_id <= 0 {
            return Ok(None);
        }
        let read = self.read()?;
        Ok(
            read_page_by_id(&*read, page_id as u64)?.map(|p| ChunkerVersionRow {
                chunker_version: p.chunker_version,
            }),
        )
    }

    /// `readPrefixAnchoredPages(sourceId, prefix)`: up to ten live pages of the source whose slug
    /// starts with `prefix` (the SQL escapes `\\`, `%` and `_` for `LIKE`, so the prefix is
    /// literal), no question, synthesis or pinned-question page, by
    /// `COALESCE(effective_date, updated_at)` newest first, then by id descending.
    pub fn read_prefix_anchored_pages(
        &self,
        source_id: &str,
        prefix: &str,
    ) -> Result<Vec<AnchoredPageRow>> {
        let read = self.read()?;
        let mut hits: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_none()
                    && p.slug.starts_with(prefix)
                    && p.page_type != "question"
                    && p.page_type != "synthesis"
                    && !p.frontmatter.contains_key(PINNED_QUESTION_KEY)
            })
            .collect();
        hits.sort_by(|a, b| {
            let date = |p: &PageRecord| p.effective_date_us.unwrap_or(p.updated_at_us);
            date(b).cmp(&date(a)).then(b.id.cmp(&a.id))
        });
        Ok(hits
            .into_iter()
            .take(ENTITY_ANCHORED_LIMIT)
            .map(|p| AnchoredPageRow {
                id: p.id,
                slug: p.slug,
            })
            .collect())
    }

    /// `readTextMentionPages(sourceIds, slugs)`: each live page whose source is among `source_ids`
    /// and whose slug is among `slugs`, with `COALESCE(effective_date, updated_at)` as `date`, in
    /// store scan order (the SQL sets no order).
    pub fn read_text_mention_pages(
        &self,
        source_ids: &[String],
        slugs: &[String],
    ) -> Result<Vec<TextMentionPageRow>> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && source_ids.contains(&p.source_id)
                    && slugs.contains(&p.slug)
            })
            .map(|p| TextMentionPageRow {
                date: iso(p.effective_date_us.unwrap_or(p.updated_at_us)),
                slug: p.slug,
                source_id: p.source_id,
                title: p.title,
                page_type: p.page_type,
                frontmatter: p.frontmatter,
            })
            .collect())
    }
}

/// `text LIKE ANY(patterns)` (`ILIKE ANY` when `fold`).
fn any_like(text: &str, patterns: &[String], fold: bool) -> Result<bool> {
    for pattern in patterns {
        if like(text, pattern, fold)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `retiredPageSql`: `canonical` is false or no, `superseded_by` or `merged_into` names a page, or
/// `status` contains the word alias, redirect or redirected.
pub(crate) fn is_retired(p: &PageRecord) -> bool {
    let text = |key: &str| {
        p.frontmatter
            .get(key)
            .and_then(arrow_text)
            .unwrap_or_default()
    };
    let canonical = text("canonical").to_lowercase();
    canonical == "false"
        || canonical == "no"
        || !text("superseded_by").trim_matches(' ').is_empty()
        || !text("merged_into").trim_matches(' ').is_empty()
        || has_retired_status_word(&text("status").to_lowercase())
}

/// The collapsed-page test of `listEntityKeyRows({ collapsed: true })`: `frontmatter -> 'dedupe_collapse'`
/// is not NULL (a JSON null value counts) and `btrim(frontmatter ->> 'merged_into')` is not empty.
pub(crate) fn is_collapsed(p: &PageRecord) -> bool {
    p.frontmatter.contains_key("dedupe_collapse")
        && !p
            .frontmatter
            .get("merged_into")
            .and_then(arrow_text)
            .unwrap_or_default()
            .trim_matches(' ')
            .is_empty()
}

/// The regex `(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)` on lowercased text.
fn has_retired_status_word(status: &str) -> bool {
    let bytes = status.as_bytes();
    let not_letter = |i: Option<&u8>| i.is_none_or(|b| !b.is_ascii_lowercase());
    ["alias", "redirect", "redirected"].iter().any(|word| {
        status.match_indices(word).any(|(at, _)| {
            let before = if at == 0 { None } else { bytes.get(at - 1) };
            not_letter(before) && not_letter(bytes.get(at + word.len()))
        })
    })
}

/// A frontmatter value as PostgreSQL's `->>` returns it: a string as is, JSON null as SQL NULL,
/// and anything else as its jsonb text.
pub(crate) fn arrow_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// The jsonb output form: `", "` and `": "` separators, object keys shorter first, then by bytes.
fn jsonb_text(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(jsonb_text).collect::<Vec<_>>().join(", ")
            )
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| {
                a.len()
                    .cmp(&b.len())
                    .then_with(|| a.as_bytes().cmp(b.as_bytes()))
            });
            let fields = keys
                .iter()
                .map(|k| format!("{}: {}", Value::String((*k).clone()), jsonb_text(&map[*k])));
            format!("{{{}}}", fields.collect::<Vec<_>>().join(", "))
        }
        other => other.to_string(),
    }
}

/// A word character of a Postgres regular expression (`\w`): a letter, a digit or `_`.
fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `text ~* '\m(name|...)\M'` with each name escaped to a literal: some name matches
/// case-insensitively (each pattern character by its lower and upper forms) where a word starts
/// and a word ends. `\m` needs a word character after it and none before, `\M` the reverse, so a
/// name that starts or ends with a non-word character never matches, and no names never match.
fn names_as_word(text: &str, names: &[Vec<char>]) -> bool {
    let chars: Vec<char> = text.chars().collect();
    names.iter().any(|name| {
        let (Some(first), Some(last)) = (name.first(), name.last()) else {
            return false;
        };
        if !word_char(*first) || !word_char(*last) || name.len() > chars.len() {
            return false;
        }
        (0..=chars.len() - name.len()).any(|start| {
            let end = start + name.len();
            (start == 0 || !word_char(chars[start - 1]))
                && chars.get(end).is_none_or(|c| !word_char(*c))
                && name
                    .iter()
                    .zip(&chars[start..end])
                    .all(|(p, t)| regex_char_matches(*p, *t, false))
        })
    })
}

/// The live pages of the source that are name-variant candidates for `q` (a type in `types` or a
/// slug matching `slug_patterns`, and a title or slug matching a probe, ILIKE) and that `policy`
/// (when given) does not hide, with their probe hits. Most hits first, then the shortest title
/// (code points), then slug in byte order; at most `q.limit`.
fn name_variant_pages(
    read: &dyn KvRead,
    source_id: &str,
    q: &NameVariantCandidateQuery,
    policy: Option<&PrivacyPolicy>,
) -> Result<Vec<(PageRecord, u64)>> {
    let mut rows = Vec::new();
    for p in all_pages(read)? {
        if p.source_id != source_id || p.deleted_at_us.is_some() {
            continue;
        }
        if !(q.types.contains(&p.page_type) || any_like(&p.slug, &q.slug_patterns, false)?) {
            continue;
        }
        let mut hits = 0u64;
        for probe in &q.probes {
            if like(&p.title, probe, true)? || like(&p.slug, probe, true)? {
                hits += 1;
            }
        }
        if hits == 0 {
            continue;
        }
        if let Some(policy) = policy
            && page_hidden(read, &p, policy)?
        {
            continue;
        }
        rows.push((p, hits));
    }
    rows.sort_by(|(a, a_hits), (b, b_hits)| {
        b_hits
            .cmp(a_hits)
            .then_with(|| a.title.chars().count().cmp(&b.title.chars().count()))
            .then_with(|| a.slug.cmp(&b.slug))
    });
    rows.truncate(usize::try_from(q.limit).unwrap_or(usize::MAX));
    Ok(rows)
}

/// One entity-card row for a live page, as `readEntityCardRows` reads it: the bounded body
/// prefix and the page's last retrieval time.
fn card_row(read: &dyn KvRead, p: PageRecord) -> Result<EntityCardRow> {
    Ok(EntityCardRow {
        compiled_truth: bounded_body_prefix(read, &p)?,
        updated_at: iso(p.updated_at_us),
        last_retrieved_at: crate::page_ops::retrievals::last_retrieved_us(read, p.id)?.map(iso),
        frontmatter: Value::Object(p.frontmatter),
        slug: p.slug,
        source_id: p.source_id,
        title: p.title,
        page_type: p.page_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_words_need_word_boundaries() {
        assert!(has_retired_status_word("alias"));
        assert!(has_retired_status_word("old-redirect"));
        assert!(has_retired_status_word("redirected to x"));
        assert!(has_retired_status_word("an alias2"));
        assert!(!has_retired_status_word("aliases"));
        assert!(!has_retired_status_word("redirector"));
        assert!(!has_retired_status_word("active"));
    }

    #[test]
    fn arrow_text_reads_as_postgres() {
        assert_eq!(arrow_text(&json!(null)), None);
        assert_eq!(arrow_text(&json!("x")).as_deref(), Some("x"));
        assert_eq!(arrow_text(&json!(false)).as_deref(), Some("false"));
        assert_eq!(arrow_text(&json!(12)).as_deref(), Some("12"));
        assert_eq!(
            arrow_text(&json!({"bb": [1, "a"], "a": null})).as_deref(),
            Some(r#"{"a": null, "bb": [1, "a"]}"#)
        );
    }
}
