//! Retrieval coverage over the projection queue: the members of
//! src/core/engine-sql/retrieval-coverage.ts that read unsealed pages. `countPendingProjectionPages`
//! counts the pages in a read scope whose text projection waits, `projectionRebuildProgress` reports an
//! upgrade's index rebuild, and `readProjectionReadiness` is the readiness probe's one statement
//! (search/projection-readiness.ts), cached under `readProjectionReadinessGeneration`.
//!
//! The scope is `scopeFilter`: the source filter, the private-page policy, the live test of
//! `pageReadFilter` (not soft-deleted, not quarantined, source present and not archived), the page
//! kind, the types and the excluded slug prefixes, and `pageEligibleSql`: the trust floor
//! (`minTrust`, the page's stamped tier at or above it) and the flagged-page filter (`suppressFlagged`,
//! no `activationSuppressedSql` receipt), both through `trust::TrustPolicy`.
//!
//! A page is served when its text projection is its knowledge revision or the pre-activation marker
//! (`servedTextProjectionFilter`); otherwise it waits. Its class is `projectionClassSql`: `archived`
//! for an archived source, `text` for a page that is not an image or is a segmented shell, `protected`
//! for an image whose body holds a protected fence, else an image that a seal or a re-import fixes.
//! The store does not tell `sealable` from `reimport`: no read here needs to.
//!
//! The relevance of the pending count is `CoverageRelevance` with its POSIX patterns given back as the
//! query words (`terms`); the TypeScript member refuses a pattern of another shape. A word matches the
//! lower-cased `title || ' ' || slug` as a whole token: the characters around it are not `[[:alnum:]]`.

use crate::Store;
use crate::cli_reads::pg_text::pg_lower;
use crate::error::Result;
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::keyword::parser::is_alnum_char;
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::persistence::activation_started_us;
use crate::sources::read_source;
use crate::trust::{TrustPolicy, TrustTier};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// `COVERAGE_COUNT_CAP`: the pending count reads at most this many pages.
const COVERAGE_COUNT_CAP: u64 = 1000;
/// `ACTIVATION_SERVED_REVISION`: a page left serving its pre-upgrade index (#9192).
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";
const QUARANTINE_KEY: &str = "quarantine";

/// `ProjectionReadinessScope`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoverageScope {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    /// The store policy of `excludePrivate`, or none when the read keeps private pages.
    #[serde(default)]
    pub exclude_private: Option<PrivacyPolicy>,
    #[serde(default)]
    pub page_kind: Option<String>,
    #[serde(default)]
    pub types: Option<Vec<String>>,
    #[serde(default)]
    pub exclude_slug_prefixes: Vec<String>,
    /// The trust floor: a page in scope has a tier at or above it. None (or empty) keeps every tier.
    #[serde(default)]
    pub min_trust: Option<String>,
    /// Leaves out a page that `activationSuppressedSql` suppresses.
    #[serde(default)]
    pub suppress_flagged: bool,
}

/// `CoverageRelevance` with its patterns given as query words.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoverageRelevance {
    pub all: bool,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default)]
    pub terms: Vec<String>,
    #[serde(default)]
    pub page_ids: Vec<u64>,
    #[serde(default)]
    pub exact_top_page_id: Option<u64>,
    #[serde(default)]
    pub image_arm: bool,
}

/// `countPendingProjectionPages` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingCountInput {
    pub scope: CoverageScope,
    pub relevance: CoverageRelevance,
}

/// `ScopedCount` of a pending count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingCount {
    pub total: u64,
    pub could_affect: u64,
    pub capped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_counted: Option<bool>,
    pub could_affect_images: u64,
}

/// `ProjectionRebuildProgress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RebuildProgress {
    pub done: u64,
    pub total: u64,
    pub pages_per_second: Option<f64>,
}

/// `ProjectionReadinessRow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadinessRow {
    pub pending: bool,
    pub by_design: bool,
}

/// `projectionClassSql`, with the two image repair classes as one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectionClass {
    Archived,
    Text,
    Protected,
    Image,
}

/// The archived flag of each source a read meets: `Some(archived)` for a present source.
struct Sources<'a> {
    read: &'a dyn KvRead,
    archived: HashMap<String, Option<bool>>,
}

impl<'a> Sources<'a> {
    fn new(read: &'a dyn KvRead) -> Self {
        Self {
            read,
            archived: HashMap::new(),
        }
    }

    fn archived(&mut self, id: &str) -> Result<Option<bool>> {
        if let Some(known) = self.archived.get(id) {
            return Ok(*known);
        }
        let flag = read_source(self.read, id)?.map(|s| s.archived);
        self.archived.insert(id.to_string(), flag);
        Ok(flag)
    }
}

/// `servedTextProjectionFilter`.
fn served(page: &PageRecord) -> bool {
    page.text_projection_revision
        .as_deref()
        .is_some_and(|r| r == page.knowledge_revision || r == ACTIVATION_SERVED_REVISION)
}

/// `projectionClassSql` for a page of a present source.
fn class(page: &PageRecord, archived: bool) -> ProjectionClass {
    let segmented = page.compiled_truth.is_null() && page.timeline.is_null();
    if archived {
        ProjectionClass::Archived
    } else if page.page_kind != "image" || segmented {
        ProjectionClass::Text
    } else if crate::pages::has_protected_text(&page.compiled_truth)
        || crate::pages::has_protected_text(&page.timeline)
    {
        ProjectionClass::Protected
    } else {
        ProjectionClass::Image
    }
}

/// Whether `page` is a live page in `scope` (`scopeFilter`). `None` when its source is missing or
/// archived, otherwise the scope test.
fn in_scope(
    read: &dyn KvRead,
    sources: &mut Sources<'_>,
    page: &PageRecord,
    scope: &CoverageScope,
) -> Result<bool> {
    if let Some(ids) = &scope.source_ids {
        if ids.is_empty() || !ids.contains(&page.source_id) {
            return Ok(false);
        }
    } else if let Some(id) = scope.source_id.as_deref().filter(|id| !id.is_empty())
        && page.source_id != id
    {
        return Ok(false);
    }
    if page.deleted_at_us.is_some() || page.frontmatter.contains_key(QUARANTINE_KEY) {
        return Ok(false);
    }
    if sources.archived(&page.source_id)? != Some(false) {
        return Ok(false);
    }
    if let Some(kind) = scope.page_kind.as_deref().filter(|k| !k.is_empty())
        && page.page_kind != kind
    {
        return Ok(false);
    }
    if let Some(types) = &scope.types
        && !types.contains(&page.page_type)
    {
        return Ok(false);
    }
    if scope
        .exclude_slug_prefixes
        .iter()
        .any(|prefix| page.slug.starts_with(prefix.as_str()))
    {
        return Ok(false);
    }
    if let Some(policy) = &scope.exclude_private
        && page_hidden(read, page, policy)?
    {
        return Ok(false);
    }
    // `pageEligibleSql`: the trust floor and the flagged-page filter (`trust::TrustPolicy`).
    TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?.admits(
        read,
        "pages",
        page.id,
        TrustTier::stored(page.trust_tier.as_deref()),
    )
}

/// `haystack ~ '(^|[^[:alnum:]])<term>([^[:alnum:]]|$)'`: `term` occurs with no alphanumeric character
/// right before or after it. Every occurrence is tried, overlapping ones included.
fn token_match(haystack: &str, term: &str) -> bool {
    if term.is_empty() {
        return false;
    }
    haystack.char_indices().any(|(at, _)| {
        haystack[at..].starts_with(term)
            && haystack[..at]
                .chars()
                .next_back()
                .is_none_or(|c| !is_alnum_char(c))
            && haystack[at + term.len()..]
                .chars()
                .next()
                .is_none_or(|c| !is_alnum_char(c))
    })
}

/// Calls `visit` with each live page in scope and its class until `visit` returns false.
fn walk_scope(
    read: &dyn KvRead,
    scope: &CoverageScope,
    mut visit: impl FnMut(&PageRecord, ProjectionClass) -> bool,
) -> Result<()> {
    let mut sources = Sources::new(read);
    for page in all_pages(read)? {
        if !in_scope(read, &mut sources, &page, scope)? {
            continue;
        }
        // In scope means the source is present and live.
        if !visit(&page, class(&page, false)) {
            break;
        }
    }
    Ok(())
}

impl Store {
    /// `countPendingProjectionPages`: unsealed pages in scope that need work (class neither
    /// `protected` nor `archived`), up to the cap, and how many could affect the query.
    pub fn count_pending_projection_pages(
        &self,
        input: &PendingCountInput,
    ) -> Result<PendingCount> {
        let read = self.read()?;
        let read = &*read;
        let relevance = &input.relevance;
        let (mut total, mut could, mut images) = (0u64, 0u64, 0u64);
        walk_scope(read, &input.scope, |page, cls| {
            if served(page) || cls == ProjectionClass::Protected {
                return true;
            }
            total += 1;
            let returned = relevance.page_ids.contains(&page.id);
            let haystack = pg_lower(&format!("{} {}", page.title, page.slug));
            let matches = relevance.all
                || relevance.types.contains(&page.page_type)
                || relevance.terms.iter().any(|t| token_match(&haystack, t))
                || returned;
            let shown = relevance.image_arm || page.page_kind != "image" || returned;
            if matches && shown {
                could += 1;
                if cls == ProjectionClass::Image {
                    images += 1;
                }
            }
            total < COVERAGE_COUNT_CAP
        })?;
        let top_counted = match relevance.exact_top_page_id {
            None => None,
            Some(id) => Some(top_counted(read, id)?),
        };
        Ok(PendingCount {
            total,
            could_affect: could,
            capped: total >= COVERAGE_COUNT_CAP,
            top_counted,
            could_affect_images: images,
        })
    }

    /// `projectionRebuildProgress`: null unless an upgrade's activation queued a rebuild; else the
    /// pages in scope that need work, those already current and the rate since the rebuild began.
    pub fn projection_rebuild_progress(
        &self,
        scope: &CoverageScope,
    ) -> Result<Option<RebuildProgress>> {
        let read = self.read()?;
        let read = &*read;
        let Some(started) = activation_started_us(read)? else {
            return Ok(None);
        };
        let seconds = (self.env.now_micros() - started) as f64 / 1_000_000.0;
        let (mut total, mut done) = (0u64, 0u64);
        walk_scope(read, scope, |page, cls| {
            if cls != ProjectionClass::Protected {
                total += 1;
                if page.text_projection_revision.as_deref()
                    == Some(page.knowledge_revision.as_str())
                {
                    done += 1;
                }
            }
            true
        })?;
        Ok(Some(RebuildProgress {
            done,
            total,
            pages_per_second: (seconds > 0.0 && done > 0).then(|| done as f64 / seconds),
        }))
    }

    /// `readProjectionReadinessGeneration`: the brain and its commit sequence. Every commit advances the
    /// sequence, so a cached readiness answer is reused only while nothing was written since it was read.
    /// A snapshot never sees a commit in flight. A store bound to a transaction reads that transaction's
    /// own writes, which the commit sequence does not count until it commits, so it answers null and the
    /// probe is never cached, as the SQL answers null while a transaction is in flight.
    pub fn projection_readiness_generation(&self) -> Result<Option<String>> {
        if self.bound.is_some() {
            return Ok(None);
        }
        self.health_memo_clock().map(Some)
    }

    /// `readHealthMemoClock`: the brain and its commit sequence.
    pub fn health_memo_clock(&self) -> Result<String> {
        Ok(format!("{}/{}", self.brain_id(), self.commit_version()?))
    }

    /// `readProjectionReadiness`: whether unsealed pages in scope need work, and when none do,
    /// whether unsealed pages are in scope by design (protected images).
    pub fn read_projection_readiness(&self, scope: &CoverageScope) -> Result<ReadinessRow> {
        let read = self.read()?;
        let read = &*read;
        let (mut pending, mut by_design) = (false, false);
        walk_scope(read, scope, |page, cls| {
            if served(page) {
                return true;
            }
            if cls == ProjectionClass::Protected {
                by_design = true;
                true
            } else {
                pending = true;
                false
            }
        })?;
        Ok(ReadinessRow {
            pending,
            by_design: !pending && by_design,
        })
    }
}

/// The exact top hit's `EXISTS`: the page with `id` is not deleted, its source is present, and it
/// waits for a projection that needs work. No scope or quarantine test applies, as in the SQL.
fn top_counted(read: &dyn KvRead, id: u64) -> Result<bool> {
    let Some(page) = read_page_by_id(read, id)? else {
        return Ok(false);
    };
    if page.deleted_at_us.is_some() || served(&page) {
        return Ok(false);
    }
    let Some(archived) = read_source(read, &page.source_id)?.map(|s| s.archived) else {
        return Ok(false);
    };
    Ok(!matches!(
        class(&page, archived),
        ProjectionClass::Protected | ProjectionClass::Archived
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_matches_only_as_a_whole_token() {
        assert!(token_match("widget launch notes/widget-plan", "widget"));
        assert!(token_match("subwidgets", "subwidgets"));
        assert!(!token_match("subwidgets notes/subwidgets", "widget"));
        assert!(!token_match("widgets", "widget"));
        assert!(token_match("a-a-a", "a-a"));
        assert!(token_match("café widget", "café"));
        assert!(!token_match("cafés", "café"));
        assert!(!token_match("anything", ""));
    }
}
