//! Withdrawal discovery reads (src/core/engine-sql/withdrawal-discovery.ts): the one
//! `readWithdrawalDiscovery` member `discoverWithdrawalTargets` (src/core/facts/withdrawal-discovery.ts)
//! calls to find every page that carries a withdrawn claim. Each kind answers what its Postgres
//! statement answers, from the fact, page and segmented-body records:
//!
//! - `claim_keys`: each claim's subject (`*` for none) and normalized text, its own or else the
//!   text of the first source fact of its visibility whose fingerprint (then v1 fingerprint) is
//!   the claim's hash.
//! - `provenance_pages`: the distinct pages (`COALESCE(source_markdown_slug, entity_slug)` in the
//!   fact's source) of the facts of a key's visibility whose fingerprint is the sha256 of the key's
//!   text (its hash when it has none), for subject `*`, the fact's entity or its owned memory page.
//! - `claim_matches`: the distinct `(id, ambiguous)` of the candidates a key matches: same or no
//!   visibility, subject `*` or the candidate's slug, hash equal to the claim's fingerprint or v1.
//! - `inline_fence_pages`: pages after `after` by id whose truth or timeline holds
//!   `gbrain:facts:` and, lowered, every pattern of a key of their subject.
//! - `segment_fence_rows`: the live published manifest rows of segmented pages with facts slots,
//!   after `(page, occurrence)`, one of whose whole slots holds every pattern of a key; each with
//!   the text of its whole slots. A row whose segment text is missing is skipped (the join).
//! - `split_fence_slots`: the open slots (`open_start`) of those rows grouped by page, region and
//!   open start, with the bytes they hold, after `(page, region, open start)`.
//! - `target_pages` and `sample_slugs`: slug, id and knowledge revision of the given page ids;
//!   up to 20 slugs in byte order.
//!
//! No kind filters soft-deleted pages or expired facts, as no statement does.

use crate::Store;
use crate::error::{Result, StoreError};
use crate::facts::{
    FactRecord, fact_fingerprint, fact_normalize, like, pg_lower_char, source_rows,
};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::page_body::live_facts_slot_rows;
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::trust::fingerprint::fact_fingerprint_v1;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const OP: &str = "readWithdrawalDiscovery";
/// The marker every facts fence opens with.
const FENCE_MARKER: &str = "gbrain:facts:";

/// One claim to key: `subject` `None` is `*`, `claim` `None` takes a source fact's text.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscoveryClaim {
    pub visibility: String,
    pub fact_hash: String,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub claim: Option<String>,
}

/// One keyed claim: its normalized text (`None` when no fact carries it) and LIKE patterns.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscoveryKey {
    pub visibility: String,
    pub fact_hash: String,
    pub subject: String,
    #[serde(default)]
    pub norm: Option<String>,
    #[serde(default)]
    pub patterns: Vec<String>,
}

/// One fence or chunk row checked against the keys.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscoveryCandidate {
    pub id: i64,
    pub slug: String,
    #[serde(default)]
    pub claim: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    pub ambiguous: bool,
}

/// `readWithdrawalDiscovery(read)`, tagged by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DiscoveryRead {
    ClaimKeys {
        source_id: String,
        claims: Vec<DiscoveryClaim>,
    },
    ProvenancePages {
        source_id: String,
        keys: Vec<DiscoveryKey>,
    },
    ClaimMatches {
        incoming: Vec<DiscoveryCandidate>,
        keys: Vec<DiscoveryKey>,
    },
    InlineFencePages {
        source_id: String,
        keys: Vec<DiscoveryKey>,
        after: i64,
        limit: u64,
        subjects: Option<Vec<String>>,
    },
    SegmentFenceRows {
        source_id: String,
        keys: Vec<DiscoveryKey>,
        after: (i64, i64),
        limit: u64,
        subjects: Option<Vec<String>>,
    },
    SplitFenceSlots {
        source_id: String,
        subjects: Option<Vec<String>>,
        after: (i64, String, i64),
        limit: u64,
    },
    TargetPages {
        source_id: String,
        ids: Vec<i64>,
    },
    SampleSlugs {
        source_id: String,
        ids: Vec<i64>,
    },
}

fn take(limit: u64) -> usize {
    usize::try_from(limit).unwrap_or(usize::MAX)
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `lower(text) LIKE ALL(patterns)`: true for no patterns, whatever the text.
fn like_all(text: Option<&str>, patterns: &[String]) -> Result<bool> {
    if patterns.is_empty() {
        return Ok(true);
    }
    let Some(text) = text else { return Ok(false) };
    let lowered: String = text.chars().map(pg_lower_char).collect();
    for pattern in patterns {
        if !like(&lowered, pattern, false)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn subject_keys<'a>(keys: &'a [DiscoveryKey], slug: &str) -> Vec<&'a DiscoveryKey> {
    keys.iter()
        .filter(|k| k.subject == "*" || k.subject == slug)
        .collect()
}

fn in_subjects(subjects: Option<&Vec<String>>, slug: &str) -> bool {
    subjects.is_none_or(|s| s.iter().any(|x| x == slug))
}

/// A slot's integer field (`(s->>'name')::bigint`); `None` when absent or null.
fn slot_int(slot: &Value, name: &str) -> Result<Option<i64>> {
    match slot.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_i64().map(Some).ok_or_else(|| {
            StoreError::invalid(format!("{OP}: facts slot {name} is not an integer"))
        }),
        Some(Value::String(s)) => s.trim().parse::<i64>().map(Some).map_err(|_| {
            StoreError::invalid(format!("invalid input syntax for type bigint: \"{s}\""))
        }),
        Some(other) => Err(StoreError::invalid(format!(
            "{OP}: facts slot {name} is {other}"
        ))),
    }
}

fn open_slot(slot: &Value) -> bool {
    slot.as_object()
        .is_some_and(|o| o.contains_key("open_start"))
}

/// `convert_from(substring(body from start + 1 for end - start), 'UTF8')`; `None` when either
/// bound is absent.
fn slot_text(body: &[u8], slot: &Value) -> Result<Option<String>> {
    let (Some(start), Some(end)) = (slot_int(slot, "start")?, slot_int(slot, "end")?) else {
        return Ok(None);
    };
    let len = end - start;
    if len < 0 {
        return Err(StoreError::invalid("negative substring length not allowed"));
    }
    let from = start.saturating_add(1);
    let lo = from.max(1);
    let hi = from
        .saturating_add(len)
        .min(i64::try_from(body.len()).unwrap_or(i64::MAX) + 1);
    let bytes = if hi <= lo {
        &[][..]
    } else {
        &body[usize::try_from(lo - 1).unwrap_or(0)..usize::try_from(hi - 1).unwrap_or(0)]
    };
    String::from_utf8(bytes.to_vec())
        .map(Some)
        .map_err(|_| StoreError::invalid("invalid byte sequence for encoding \"UTF8\""))
}

fn source_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| p.source_id == source_id)
        .collect();
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

fn pages_by_id(read: &dyn KvRead, source_id: &str, ids: &[i64]) -> Result<Vec<PageRecord>> {
    let wanted: BTreeSet<u64> = ids
        .iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect();
    let mut out = Vec::new();
    for id in wanted {
        if let Some(page) = read_page_by_id(read, id)?
            && page.source_id == source_id
        {
            out.push(page);
        }
    }
    Ok(out)
}

/// `claim_keys`' fallback text: the first source fact of `visibility` whose `hash` matches.
fn fact_text(
    rows: &[FactRecord],
    visibility: &str,
    hash: &str,
    fingerprint: fn(&str) -> String,
) -> Option<String> {
    rows.iter()
        .find(|f| f.visibility == visibility && fingerprint(&f.fact) == hash)
        .map(|f| f.fact.clone())
}

fn claim_keys(read: &dyn KvRead, source_id: &str, claims: &[DiscoveryClaim]) -> Result<Vec<Value>> {
    let mut rows = source_rows(read, source_id)?;
    rows.sort_by_key(|f| f.id);
    Ok(claims
        .iter()
        .map(|c| {
            let text = c
                .claim
                .clone()
                .or_else(|| fact_text(&rows, &c.visibility, &c.fact_hash, fact_fingerprint))
                .or_else(|| fact_text(&rows, &c.visibility, &c.fact_hash, fact_fingerprint_v1));
            json!({
                "visibility": c.visibility,
                "fact_hash": c.fact_hash,
                "subject": c.subject.as_deref().unwrap_or("*"),
                "norm": text.map(|t| fact_normalize(&t)),
            })
        })
        .collect())
}

fn provenance_pages(
    read: &dyn KvRead,
    source_id: &str,
    keys: &[DiscoveryKey],
) -> Result<Vec<Value>> {
    let rows = source_rows(read, source_id)?;
    let mut ids = BTreeSet::new();
    for key in keys {
        let hash = key
            .norm
            .as_deref()
            .map_or_else(|| key.fact_hash.clone(), sha256_hex);
        for f in &rows {
            let subject_hit = key.subject == "*"
                || f.entity_slug.as_deref() == Some(key.subject.as_str())
                || (f.on_owned_memory_page()
                    && f.source_markdown_slug.as_deref() == Some(key.subject.as_str()));
            if f.visibility != key.visibility || !subject_hit || fact_fingerprint(&f.fact) != hash {
                continue;
            }
            let Some(slug) = f
                .source_markdown_slug
                .as_deref()
                .or(f.entity_slug.as_deref())
            else {
                continue;
            };
            if let Some(page) = read_page(read, &f.source_id, slug)? {
                ids.insert(page.id);
            }
        }
    }
    Ok(ids.into_iter().map(|id| json!({ "id": id })).collect())
}

fn claim_matches(incoming: &[DiscoveryCandidate], keys: &[DiscoveryKey]) -> Vec<Value> {
    let mut hits = BTreeSet::new();
    for i in incoming {
        let Some(claim) = i.claim.as_deref() else {
            continue;
        };
        let hashes = [fact_fingerprint(claim), fact_fingerprint_v1(claim)];
        let matched = keys.iter().any(|w| {
            i.visibility.as_deref().is_none_or(|v| v == w.visibility)
                && (w.subject == "*" || w.subject == i.slug)
                && hashes.contains(&w.fact_hash)
        });
        if matched {
            hits.insert((i.id, i.ambiguous));
        }
    }
    hits.into_iter()
        .map(|(id, ambiguous)| json!({ "id": id, "ambiguous": ambiguous }))
        .collect()
}

fn inline_fence_pages(
    read: &dyn KvRead,
    source_id: &str,
    keys: &[DiscoveryKey],
    after: i64,
    limit: u64,
    subjects: Option<&Vec<String>>,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for page in source_pages(read, source_id)? {
        if out.len() >= take(limit) {
            break;
        }
        if i128::from(page.id) <= i128::from(after) || !in_subjects(subjects, &page.slug) {
            continue;
        }
        let (truth, timeline) = (page.compiled_truth.as_deref(), page.timeline.as_deref());
        if !truth.is_some_and(|t| t.contains(FENCE_MARKER))
            && !timeline.is_some_and(|t| t.contains(FENCE_MARKER))
        {
            continue;
        }
        let mut hit = false;
        for key in subject_keys(keys, &page.slug) {
            if like_all(truth, &key.patterns)? || like_all(timeline, &key.patterns)? {
                hit = true;
                break;
            }
        }
        if hit {
            out.push(json!({ "id": page.id, "slug": page.slug, "compiled_truth": truth, "timeline": timeline }));
        }
    }
    Ok(out)
}

fn segment_fence_rows(
    read: &dyn KvRead,
    source_id: &str,
    keys: &[DiscoveryKey],
    after: (i64, i64),
    limit: u64,
    subjects: Option<&Vec<String>>,
) -> Result<Vec<Value>> {
    let mut hits: Vec<((i64, i64), Value)> = Vec::new();
    for page in source_pages(read, source_id)? {
        if !in_subjects(subjects, &page.slug) {
            continue;
        }
        let page_keys = subject_keys(keys, &page.slug);
        let page_id = i64::try_from(page.id).unwrap_or(i64::MAX);
        for (row, text) in live_facts_slot_rows(read, page.id)? {
            let Some(body) = text else { continue };
            if (row.page_id, row.occurrence_id) <= after {
                continue;
            }
            let slots = row
                .facts_slots
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let mut fences = Vec::new();
            for slot in slots.iter().filter(|s| !open_slot(s)) {
                fences.push(slot_text(&body, slot)?);
            }
            let mut hit = false;
            'keys: for key in &page_keys {
                for fence in &fences {
                    if like_all(fence.as_deref(), &key.patterns)? {
                        hit = true;
                        break 'keys;
                    }
                }
            }
            if hit {
                hits.push((
                    (row.page_id, row.occurrence_id),
                    json!({ "id": page_id, "occurrence_id": row.occurrence_id.to_string(), "slug": page.slug, "fences": fences }),
                ));
            }
        }
    }
    hits.sort_by_key(|h| h.0);
    Ok(hits.into_iter().take(take(limit)).map(|h| h.1).collect())
}

fn split_fence_slots(
    read: &dyn KvRead,
    source_id: &str,
    subjects: Option<&Vec<String>>,
    after: &(i64, String, i64),
    limit: u64,
) -> Result<Vec<Value>> {
    // (page, region, open start) -> (slug, bytes over the slots whose bounds are both set).
    let mut groups: std::collections::BTreeMap<(i64, String, i64), (String, Option<i64>)> =
        Default::default();
    for page in source_pages(read, source_id)? {
        if !in_subjects(subjects, &page.slug) {
            continue;
        }
        for (row, _) in live_facts_slot_rows(read, page.id)? {
            for slot in row
                .facts_slots
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                if !open_slot(slot) {
                    continue;
                }
                let Some(open_start) = slot_int(slot, "open_start")? else {
                    continue;
                };
                let key = (row.page_id, row.region.clone(), open_start);
                if key.0 < after.0
                    || (key.0 == after.0
                        && (key.1.as_bytes(), key.2) <= (after.1.as_bytes(), after.2))
                {
                    continue;
                }
                let bytes = match (slot_int(slot, "start")?, slot_int(slot, "end")?) {
                    (Some(start), Some(end)) => Some(end - start),
                    _ => None,
                };
                let entry = groups
                    .entry(key)
                    .or_insert_with(|| (page.slug.clone(), None));
                if let Some(b) = bytes {
                    entry.1 = Some(entry.1.unwrap_or(0) + b);
                }
            }
        }
    }
    Ok(groups
        .into_iter()
        .take(take(limit))
        .map(|((page_id, region, open_start), (slug, bytes))| {
            json!({
                "page_id": page_id,
                "slug": slug,
                "region": region,
                "open_start": open_start.to_string(),
                "bytes": bytes.map(|b| b.to_string()),
            })
        })
        .collect())
}

impl Store {
    /// `readWithdrawalDiscovery(read)`: the rows of one withdrawal discovery read (module docs).
    pub fn read_withdrawal_discovery(&self, q: &DiscoveryRead) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        match q {
            DiscoveryRead::ClaimKeys { source_id, claims } => {
                no_nul(OP, &[("sourceId", source_id)])?;
                claim_keys(read, source_id, claims)
            }
            DiscoveryRead::ProvenancePages { source_id, keys } => {
                no_nul(OP, &[("sourceId", source_id)])?;
                provenance_pages(read, source_id, keys)
            }
            DiscoveryRead::ClaimMatches { incoming, keys } => Ok(claim_matches(incoming, keys)),
            DiscoveryRead::InlineFencePages { source_id, keys, after, limit, subjects } => {
                no_nul(OP, &[("sourceId", source_id)])?;
                inline_fence_pages(read, source_id, keys, *after, *limit, subjects.as_ref())
            }
            DiscoveryRead::SegmentFenceRows { source_id, keys, after, limit, subjects } => {
                no_nul(OP, &[("sourceId", source_id)])?;
                segment_fence_rows(read, source_id, keys, *after, *limit, subjects.as_ref())
            }
            DiscoveryRead::SplitFenceSlots { source_id, subjects, after, limit } => {
                no_nul(OP, &[("sourceId", source_id)])?;
                split_fence_slots(read, source_id, subjects.as_ref(), after, *limit)
            }
            DiscoveryRead::TargetPages { source_id, ids } => Ok(pages_by_id(read, source_id, ids)?
                .into_iter()
                .map(|p| json!({ "slug": p.slug, "page_id": p.id, "revision": p.knowledge_revision }))
                .collect()),
            DiscoveryRead::SampleSlugs { source_id, ids } => {
                let mut slugs: Vec<String> = pages_by_id(read, source_id, ids)?.into_iter().map(|p| p.slug).collect();
                slugs.sort();
                Ok(slugs.into_iter().take(20).map(|slug| json!({ "slug": slug })).collect())
            }
        }
    }
}
