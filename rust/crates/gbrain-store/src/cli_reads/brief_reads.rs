//! The proactive brief's calendar, loop and page-edit reads, which the CLI made through
//! `executeRaw` (`src/core/engine-sql/brief-reads.ts`).
//!
//! The page reads filter on live pages, apply the page policy when one is given and apply the
//! page eligibility (`pageEligibleSql`) as [`TrustPolicy`]. The projection reads (facts, timeline
//! entries) apply `projectionEligibleSql`: rows of a soft-deleted or quarantined page are hidden;
//! the store writes no `needs_rederive` rows, so that clause hides nothing here.
//!
//! Known differences from the SQL, each outside what the brief sends:
//! - `start` compares by bytes; PostgreSQL compares in the database collation, which under a
//!   linguistic collation can order punctuation (the brief's `~` upper bound) differently.
//! - The timeline read takes the date of `since` in UTC; PostgreSQL takes it in the session time
//!   zone. `since` must be the ISO form `Date#toISOString` gives.
use crate::Store;
use crate::aliases::alias_rows;
use crate::cli_reads::entities::arrow_text;
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::facts::{
    PrivacyPolicy, hidden_by_deleted_page, hidden_by_policy, hidden_by_quarantine, page_hidden,
    read_fact,
};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, VersionRecord, all_pages, read_page, read_page_by_id};
use crate::timeline::{TimelineRecord, eligible_page, event_visible};
use crate::trust::{TrustPolicy, TrustTier};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

pub use crate::cli_reads::reflex_reads::BriefEligibility;

/// One `readBriefMeetingPages` row: `start` and `account` as `->>` text, `attendees` as `->`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BriefMeetingPageRow {
    pub slug: String,
    pub source_id: String,
    pub start: Option<String>,
    pub attendees: Value,
    pub account: Option<String>,
}

/// One `readBriefEmailAliasPages` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BriefEmailAliasPageRow {
    pub alias_norm: String,
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
}

/// One `readBriefWorldFacts` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BriefWorldFactRow {
    pub id: u64,
    pub fact: String,
    pub trust_tier: String,
    pub write_origin: Option<Value>,
}

/// The `readBriefEditPage` row: the body is null past the byte ceiling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BriefEditPageRow {
    pub id: u64,
    pub compiled_truth: Option<String>,
    pub timeline: Option<String>,
    pub trust_tier: String,
    pub write_origin: Option<Value>,
}

/// The `readBriefTimelineEntry` row; `created_at` is ISO.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BriefTimelineEntryRow {
    pub id: u64,
    pub date: String,
    pub summary: String,
    pub detail: String,
    pub created_at: String,
}

/// One `readBriefPageVersions` row; `snapshot_at` is ISO and the body is null past the ceiling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BriefPageVersionRow {
    pub id: u64,
    pub compiled_truth: Option<String>,
    pub timeline: Option<String>,
    pub snapshot_at: String,
    pub is_deleted: bool,
}

/// `CASE WHEN octet_length(body) + octet_length(COALESCE(timeline, '')) <= max THEN body END`.
fn bounded(body: Option<&str>, timeline: Option<&str>, max_bytes: i64) -> Option<String> {
    let body = body?;
    let total = body.len() as i128 + timeline.map_or(0, str::len) as i128;
    (total <= max_bytes as i128).then(|| body.to_string())
}

fn trust_of(eligibility: &BriefEligibility) -> Result<TrustPolicy> {
    TrustPolicy::parse(
        eligibility.min_trust.as_deref(),
        eligibility.suppress_flagged,
    )
}

/// Whether the live page passes the policy (when given) and the page eligibility.
fn page_admitted(
    read: &dyn KvRead,
    p: &PageRecord,
    policy: Option<&PrivacyPolicy>,
    trust: &TrustPolicy,
) -> Result<bool> {
    if let Some(policy) = policy
        && page_hidden(read, p, policy)?
    {
        return Ok(false);
    }
    trust.admits(
        read,
        "pages",
        p.id,
        TrustTier::stored(p.trust_tier.as_deref()),
    )
}

fn since_micros(since: &str) -> Result<i64> {
    parse_iso(since).ok_or_else(|| {
        StoreError::invalid(format!("since: \"{since}\" is not an ISO UTC timestamp"))
    })
}

impl Store {
    /// `readBriefMeetingPages(sourceIds, startFrom, startTo, eligibility)`: the live meeting pages
    /// of the sources whose frontmatter `start` text lies in `[start_from, start_to]`, under the
    /// read floor `policy` and the eligibility, in store scan order (the SQL sets none).
    pub fn read_brief_meeting_pages(
        &self,
        source_ids: &[String],
        start_from: &str,
        start_to: &str,
        policy: Option<&PrivacyPolicy>,
        eligibility: &BriefEligibility,
    ) -> Result<Vec<BriefMeetingPageRow>> {
        let trust = trust_of(eligibility)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for p in all_pages(&*read)? {
            if p.deleted_at_us.is_some()
                || p.page_type != "meeting"
                || !source_ids.contains(&p.source_id)
            {
                continue;
            }
            let start = p.frontmatter.get("start").and_then(arrow_text);
            let Some(at) = start.as_deref() else { continue };
            if at < start_from || at > start_to || !page_admitted(&*read, &p, policy, &trust)? {
                continue;
            }
            out.push(BriefMeetingPageRow {
                account: p.frontmatter.get("account").and_then(arrow_text),
                attendees: p
                    .frontmatter
                    .get("attendees")
                    .cloned()
                    .unwrap_or(Value::Null),
                start,
                slug: p.slug,
                source_id: p.source_id,
            });
        }
        Ok(out)
    }

    /// `readBriefEmailAliasPages(sourceId, emails, eligibility)`: one row per `page_aliases` row
    /// (one per origin) of the source whose alias is in `emails` and whose live page the policy
    /// and eligibility admit. In alias, then slug, then origin byte order (the SQL sets none).
    pub fn read_brief_email_alias_pages(
        &self,
        source_id: &str,
        emails: &[String],
        policy: Option<&PrivacyPolicy>,
        eligibility: &BriefEligibility,
    ) -> Result<Vec<BriefEmailAliasPageRow>> {
        let trust = trust_of(eligibility)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for email in emails.iter().collect::<BTreeSet<_>>() {
            for slug in alias_rows(&*read, source_id, email)? {
                let Some(p) = read_page(&*read, source_id, &slug)? else {
                    continue;
                };
                if p.deleted_at_us.is_some() || !page_admitted(&*read, &p, policy, &trust)? {
                    continue;
                }
                out.push(BriefEmailAliasPageRow {
                    alias_norm: email.clone(),
                    slug: p.slug,
                    title: p.title,
                    page_type: p.page_type,
                });
            }
        }
        Ok(out)
    }

    /// `readBriefWorldFacts(factIds, eligibility)`: the facts among the ids that are active,
    /// world-visible, not hidden by the fact `policy` (when given) and eligible, in id order.
    pub fn read_brief_world_facts(
        &self,
        fact_ids: &[u64],
        policy: Option<PrivacyPolicy>,
        eligibility: &BriefEligibility,
    ) -> Result<Vec<BriefWorldFactRow>> {
        let trust = trust_of(eligibility)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in fact_ids.iter().copied().collect::<BTreeSet<_>>() {
            let Some(row) = read_fact(&*read, id)? else {
                continue;
            };
            if row.expired_at_us.is_some()
                || row.visibility != "world"
                || hidden_by_policy(&*read, &row, &policy)?
                || hidden_by_deleted_page(&*read, &row)?
                || hidden_by_quarantine(&*read, &row)?
                || !trust.admits(&*read, "facts", row.id, row.tier())?
            {
                continue;
            }
            out.push(BriefWorldFactRow {
                id: row.id,
                trust_tier: row.tier().as_str().to_string(),
                fact: row.fact,
                write_origin: row.write_origin,
            });
        }
        Ok(out)
    }

    /// `readBriefEditPage(sourceId, slug, maxBytes, opts)`: the live page at (source, slug) under
    /// the policy (when given) and the eligibility, or none; its body is none past `max_bytes`.
    pub fn read_brief_edit_page(
        &self,
        source_id: &str,
        slug: &str,
        max_bytes: i64,
        policy: Option<&PrivacyPolicy>,
        eligibility: &BriefEligibility,
    ) -> Result<Option<BriefEditPageRow>> {
        let trust = trust_of(eligibility)?;
        let read = self.read()?;
        let Some(p) = read_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        if p.deleted_at_us.is_some() || !page_admitted(&*read, &p, policy, &trust)? {
            return Ok(None);
        }
        Ok(Some(BriefEditPageRow {
            id: p.id,
            compiled_truth: bounded(
                p.compiled_truth.as_deref(),
                p.timeline.as_deref(),
                max_bytes,
            ),
            timeline: p.timeline.as_deref().map(str::to_string),
            trust_tier: TrustTier::stored(p.trust_tier.as_deref())
                .as_str()
                .to_string(),
            write_origin: p.write_origin,
        }))
    }

    /// `readBriefTimelineEntry(pageId, since, opts)`: the page's newest entry recorded at or after
    /// `since` and dated on or after its UTC date, under the event-page `policy` (when given) and
    /// the projection eligibility, by created_at, then date, then id.
    pub fn read_brief_timeline_entry(
        &self,
        page_id: u64,
        since: &str,
        policy: Option<&PrivacyPolicy>,
        eligibility: &BriefEligibility,
    ) -> Result<Option<BriefTimelineEntryRow>> {
        let since_us = since_micros(since)?;
        let since_date = iso(since_us)[..10].to_string();
        let trust = trust_of(eligibility)?;
        let read = self.read()?;
        if read_page_by_id(&*read, page_id)?.is_some_and(|p| !eligible_page(&p)) {
            return Ok(None);
        }
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::timeline_prefix(page_id),
            false,
            &mut |_, v| {
                match serde_json::from_slice::<TimelineRecord>(v) {
                    Ok(row) => rows.push(row),
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none()
            },
        )?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut best: Option<TimelineRecord> = None;
        for row in rows {
            if row.created_at_us < since_us || row.date < since_date {
                continue;
            }
            if let Some(policy) = policy
                && !event_visible(&*read, &row, policy)?
            {
                continue;
            }
            if !trust.admits(&*read, "timeline_entries", row.id, row.trust.tier())? {
                continue;
            }
            let newer = best.as_ref().is_none_or(|b| {
                (row.created_at_us, &row.date, row.id) > (b.created_at_us, &b.date, b.id)
            });
            if newer {
                best = Some(row);
            }
        }
        Ok(best.map(|row| BriefTimelineEntryRow {
            id: row.id,
            created_at: iso(row.created_at_us),
            date: row.date,
            summary: row.summary,
            detail: row.detail,
        }))
    }

    /// `readBriefPageVersions(pageId, since, maxBytes, limit)`: the page's newest `limit`
    /// revisions snapshotted at or after `since`, by id descending; a body is none past
    /// `max_bytes` or on a segmented snapshot.
    pub fn read_brief_page_versions(
        &self,
        page_id: u64,
        since: &str,
        max_bytes: i64,
        limit: usize,
    ) -> Result<Vec<BriefPageVersionRow>> {
        let since_us = since_micros(since)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::version_prefix(page_id),
            false,
            &mut |_, v| {
                match serde_json::from_slice::<VersionRecord>(v) {
                    Ok(row) => rows.push(row),
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none()
            },
        )?;
        if let Some(e) = failure {
            return Err(e);
        }
        rows.retain(|v| v.snapshot_at_us >= since_us);
        rows.sort_by_key(|v| std::cmp::Reverse(v.id));
        rows.truncate(limit);
        Ok(rows
            .into_iter()
            .map(|v| BriefPageVersionRow {
                id: v.id,
                compiled_truth: bounded(
                    v.compiled_truth.as_deref(),
                    v.timeline.as_deref(),
                    max_bytes,
                ),
                timeline: v.timeline.as_deref().map(str::to_string),
                snapshot_at: iso(v.snapshot_at_us),
                is_deleted: v.is_deleted,
            })
            .collect())
    }
}
