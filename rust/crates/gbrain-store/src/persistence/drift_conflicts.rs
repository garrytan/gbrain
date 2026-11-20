//! The drift-conflict audit reads: `readDriftConflictBounds`, `countDriftConflicts`,
//! `listDriftConflictGroups`, `readNewestCommittedReceipts` and `readPageSourcePaths` of
//! `src/core/engine-sql/drift-conflicts.ts`, the rows `list_write_conflicts` and
//! `gbrain sources reconcile --audit --conflicts` group by slug.
//!
//! A conflict row is a `source_changed` conflict of the source's current incarnation with a
//! sequence in (floor, through]. Text follows PGLite: `lower()` is `pg_text::pg_lower`, a slug
//! prefix matches as the audit's `LIKE` does, the slug order and the cursor compare bytes, and
//! the times are UTC seconds (`to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`).

use super::{all_requests, extra_bool};
use crate::Store;
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::pages::read_page;
use crate::sources::read_source;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The audit filter: the window, the normalized slug prefixes (`None` skips the fence) and
/// whether the slug's page must be live (`live`; the page policy, when sent, also applies).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftConflictFilter {
    pub source_id: String,
    pub incarnation: String,
    /// The exclusive lower sequence bound, as decimal text (may be negative).
    pub floor: String,
    /// The inclusive upper sequence bound, as decimal text.
    pub through: String,
    #[serde(default)]
    pub slug_prefixes: Option<Vec<String>>,
    #[serde(default)]
    pub live: bool,
}

/// One groups page: the slugs after `after` (bytes), at most `fetch` of them.
#[derive(Debug, Clone, Deserialize)]
pub struct DriftConflictPage {
    pub after: String,
    pub fetch: u32,
}

/// The audit's LIKE escape (backslash, `%` and `_`), as the bound `$k` of an exact prefix holds it.
fn like_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A prefix ending in `/` is `lower(slug) LIKE escaped || '%'`: the slug starts with it. Any
/// other is `lower(slug) = escaped OR lower(slug) LIKE escaped || '/%'`: the equality compares
/// the escaped text, the LIKE matches under the prefix.
fn prefix_matches(lower_slug: &str, base: &str) -> bool {
    if base.ends_with('/') {
        lower_slug.starts_with(base)
    } else {
        lower_slug == like_escape(base) || lower_slug.starts_with(&format!("{base}/"))
    }
}

fn bound(text: &str, what: &str) -> Result<i128> {
    text.parse::<i128>()
        .map_err(|_| StoreError::invalid(format!("{what} is not a sequence")))
}

fn seconds(us: i64) -> String {
    format!("{}Z", &iso(us)[..19])
}

/// `r.operation || COALESCE(':' || (r.intent->>'kind'), '')`.
fn producer(request: &RequestRecord) -> String {
    match request.intent.get("kind") {
        None | Some(Value::Null) => request.operation.clone(),
        Some(Value::String(kind)) => format!("{}:{kind}", request.operation),
        Some(other) => format!("{}:{}", request.operation, jsonb_text(other)),
    }
}

/// The conflict rows under the filter, in key order.
fn conflict_rows(
    read: &dyn KvRead,
    filter: &DriftConflictFilter,
    policy: Option<&PrivacyPolicy>,
) -> Result<Vec<RequestRecord>> {
    let floor = bound(&filter.floor, "drift-conflict floor")?;
    let through = bound(&filter.through, "drift-conflict through")?;
    let incarnation = filter.incarnation.to_lowercase();
    let mut visible: HashMap<String, bool> = HashMap::new();
    let mut out = Vec::new();
    for r in all_requests(read)? {
        let seq = i128::from(r.sequence);
        if r.source_id != filter.source_id
            || r.source_incarnation.to_lowercase() != incarnation
            || seq <= floor
            || seq > through
            || r.state != "conflict"
            || r.error_code.as_deref() != Some("source_changed")
        {
            continue;
        }
        if let Some(prefixes) = &filter.slug_prefixes {
            let lower = pg_lower(&r.slug);
            if !prefixes.iter().any(|p| prefix_matches(&lower, p)) {
                continue;
            }
        }
        if filter.live || policy.is_some() {
            let shown = match visible.get(&r.slug) {
                Some(shown) => *shown,
                None => {
                    let shown = match read_page(read, &r.source_id, &r.slug)?
                        .filter(|p| p.deleted_at_us.is_none())
                    {
                        None => false,
                        Some(page) => match policy {
                            None => true,
                            Some(policy) => !page_hidden(read, &page, policy)?,
                        },
                    };
                    visible.insert(r.slug.clone(), shown);
                    shown
                }
            };
            if !shown {
                continue;
            }
        }
        out.push(r);
    }
    Ok(out)
}

impl Store {
    /// `readDriftConflictBounds(sourceId)`: the source's incarnation and that incarnation's top
    /// and bottom request sequences as text (null with no request), or null for no source.
    pub fn read_drift_conflict_bounds(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(Value::Null);
        };
        let incarnation = source.incarnation.to_lowercase();
        let (mut top, mut bottom) = (None::<u64>, None::<u64>);
        for r in all_requests(&*read)? {
            if r.source_incarnation.to_lowercase() == incarnation {
                top = Some(top.map_or(r.sequence, |t| t.max(r.sequence)));
                bottom = Some(bottom.map_or(r.sequence, |b| b.min(r.sequence)));
            }
        }
        Ok(json!({
            "incarnation": incarnation,
            "top": top.map(|t| t.to_string()),
            "bottom": bottom.map(|b| b.to_string()),
        }))
    }

    /// `countDriftConflicts(filter)`: `{ slugs, receipts }` under the filter.
    pub fn count_drift_conflicts(
        &self,
        filter: &DriftConflictFilter,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Value> {
        let rows = conflict_rows(&*self.read()?, filter, policy)?;
        let slugs: BTreeSet<&str> = rows.iter().map(|r| r.slug.as_str()).collect();
        Ok(json!({ "slugs": slugs.len(), "receipts": rows.len() }))
    }

    /// `listDriftConflictGroups(filter, page)`: one row per slug after `page.after`, in byte
    /// order, at most `page.fetch`; `drift_receipts` counts the receipts whose message is
    /// `message` (the audit binds FILE_DRIFT_MESSAGE).
    pub fn list_drift_conflict_groups(
        &self,
        filter: &DriftConflictFilter,
        page: &DriftConflictPage,
        policy: Option<&PrivacyPolicy>,
        message: &str,
    ) -> Result<Vec<Value>> {
        let rows = conflict_rows(&*self.read()?, filter, policy)?;
        let mut groups: BTreeMap<&[u8], Vec<&RequestRecord>> = BTreeMap::new();
        for r in &rows {
            if r.slug.as_bytes() > page.after.as_bytes() {
                groups.entry(r.slug.as_bytes()).or_default().push(r);
            }
        }
        Ok(groups
            .into_values()
            .take(page.fetch as usize)
            .map(|group| {
                let drift = group
                    .iter()
                    .filter(|r| r.error_message.as_deref() == Some(message))
                    .count();
                let first = group.iter().map(|r| r.created_at_us).min().unwrap_or(0);
                let last = group.iter().map(|r| r.created_at_us).max().unwrap_or(0);
                let producers: BTreeSet<Vec<u8>> =
                    group.iter().map(|r| producer(r).into_bytes()).collect();
                let producers: Vec<String> = producers
                    .into_iter()
                    .map(|p| String::from_utf8(p).unwrap_or_default())
                    .collect();
                let newest = group
                    .iter()
                    .max_by_key(|r| r.sequence)
                    .map(|r| r.request_id.clone());
                json!({
                    "slug": group[0].slug,
                    "receipts": group.len(),
                    "drift_receipts": drift,
                    "first_seen": seconds(first),
                    "last_seen": seconds(last),
                    "producers": producers,
                    "last_request_id": newest,
                })
            })
            .collect())
    }

    /// `readNewestCommittedReceipts(sourceId, slugs)`: per slug, the committed, uncompacted
    /// receipt with an intent and the highest sequence, in slug byte order.
    pub fn read_newest_committed_receipts(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let mut newest: BTreeMap<Vec<u8>, RequestRecord> = BTreeMap::new();
        for r in all_requests(&*self.read()?)? {
            if r.source_id != source_id
                || !wanted.contains(r.slug.as_str())
                || r.intent.is_null()
                || extra_bool(&r, "compacted")
                || r.state != "committed"
            {
                continue;
            }
            let key = r.slug.as_bytes().to_vec();
            if newest.get(&key).is_none_or(|n| r.sequence > n.sequence) {
                newest.insert(key, r);
            }
        }
        Ok(newest
            .into_values()
            .map(|r| {
                json!({
                    "slug": r.slug,
                    "request_id": r.request_id,
                    "completed_at": r.completed_at_us.map(seconds),
                })
            })
            .collect())
    }

    /// `readPageSourcePaths(sourceId, slugs)`: the recorded `source_path` and `source_uri` of
    /// each live page at `slugs`, once per slug.
    pub fn read_page_source_paths(&self, source_id: &str, slugs: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for slug in slugs {
            if !seen.insert(slug.as_str()) {
                continue;
            }
            if let Some(p) =
                read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
            {
                out.push(json!({ "slug": p.slug, "source_path": p.source_path, "source_uri": p.source_uri }));
            }
        }
        Ok(out)
    }
}
