//! The valid-time reads of one page (src/core/engine-sql/trust-tier-reads.ts, "Valid time"): the
//! reads `get_page` with `as_of` made through `executeRaw`.
//!
//! - [`Store::list_valid_time_identities`]: the live pages with a slug a valid-time read may follow,
//!   with their file, their source's checkout and the no-caller page policy's verdict.
//! - [`Store::pick_valid_time_edition`]: the edition in force on a date, over the page and its
//!   version records (`V page_id id` keys), with the ambiguity window and the history counts.
//!
//! - [`Store::read_page_version_edition`]: one version record of the page, as the as-of read loads
//!   it as its edition.
//! - [`Store::read_cursor_edition`]: whether the page is still at a window cursor's revision, and the
//!   newest version record at it.
//!
//! The pick reads each version's change reason (`replacedBecauseSql`), its `successor_pruned` mark
//! and the page's `version_history_gap_at`, which the store's version prune sets as PGLite's does
//! (`version_prune.rs`). The TypeScript member
//! (src/core/rust-engine/store-members/trust-tier-reads.ts) refuses a caller policy that is not the
//! no-caller one and a date that is not `YYYY-MM-DD`.

use super::TrustTier;
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{PrivacyPolicy, page_hidden, version_hidden};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::page_body::segmented_reference;
use crate::pages::{VersionRecord, read_page_by_id};
use crate::sources::read_source;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;

/// The ordinal the current page takes after every version id (`VALID_TIME_CURRENT_ORD`).
pub const VALID_TIME_CURRENT_ORD: i64 = 2_147_483_648;

/// The most identities one read lists (a read that finds more than one refuses).
const IDENTITY_LIMIT: usize = 6;

/// `listValidTimeIdentities(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidTimeIdentityQuery {
    pub slug: String,
    /// Only this source; null is any.
    pub source_id: Option<String>,
    /// Only these sources; null is any.
    pub source_ids: Option<Vec<String>>,
    /// `excludePrivate`: the page policy over `p` (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
    /// The no-caller page policy `world` reports.
    pub world: PrivacyPolicy,
}

/// `listAmendmentsNotApplied`: the `amends` links to one page that an as-of edition does not fold in
/// (`Store::list_amendments_not_applied`, link_queries/link_temporal.rs).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendmentsQuery {
    pub page_id: i64,
    /// The edition's `valid_from`, `YYYY-MM-DD`.
    pub edition_from: String,
    /// `YYYY-MM-DD`.
    pub as_of: String,
    /// The no-caller page policy, applied to the amending page and the link's origin page; none keeps every row.
    #[serde(default)]
    pub exclude_private: Option<PrivacyPolicy>,
    /// Only amending pages in these sources; none is any.
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    pub limit: u64,
}

/// `readPageVersionEdition(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionEditionQuery {
    pub page_id: i64,
    pub version_id: i64,
}

/// `readCursorEdition(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorEditionQuery {
    pub page_id: i64,
    pub revision: String,
}

/// `pickValidTimeEdition(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidTimePickQuery {
    pub page_id: i64,
    /// `YYYY-MM-DD`.
    pub as_of: String,
    /// The pick still reports every row's visibility; it only changes which reason counts.
    pub exclude_private: bool,
    /// Measure this ordinal instead of picking.
    pub pin_ord: Option<i64>,
    /// A version body over this many bytes counts as large.
    pub inline_max_bytes: i64,
    /// The page policy over `p` and the snapshot policy over a version (`facts/privacy.rs`).
    pub policy: PrivacyPolicy,
}

/// The calendar date a frontmatter value declares (`validDate`): `YYYY-MM-DD`, optionally followed
/// by `T00:00:00`, a zero fraction and `Z` or `+00:00`, with a real calendar date from year 1000.
pub(crate) fn valid_date(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?;
    let b = s.as_bytes();
    if b.len() < 10 {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !digits(0..4) || b[4] != b'-' || !digits(5..7) || b[7] != b'-' || !digits(8..10) {
        return None;
    }
    if !midnight_utc(&s[10..]) {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if year < 1000 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(s[..10].to_string())
}

/// The accepted tail after the date: nothing, or `T00:00:00`, an optional `.0…`, then `Z` or `+00:00`.
fn midnight_utc(tail: &str) -> bool {
    if tail.is_empty() {
        return true;
    }
    let Some(rest) = tail.strip_prefix("T00:00:00") else {
        return false;
    };
    let rest = match rest.strip_prefix('.') {
        Some(fraction) => {
            let zeros = fraction.bytes().take_while(|&c| c == b'0').count();
            if zeros == 0 {
                return false;
            }
            &fraction[zeros..]
        }
        None => rest,
    };
    rest == "Z" || rest == "+00:00"
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// One row of the pick: a version, or the current page.
struct EditionRow {
    version_id: Option<u64>,
    ord: i64,
    replaced_at: Option<String>,
    valid_from: Option<String>,
    valid_until: Option<String>,
    /// Equal for two rows with the same body (`PV_BODY_KEY` / `P_BODY_KEY`).
    body_key: String,
    visible: bool,
    /// `replacedBecauseSql`: the reason given for the write that replaced the row; always none on
    /// the current page.
    reason: Option<String>,
    /// `page_versions.successor_pruned`; false on the current page.
    successor_pruned: bool,
    tier: &'static str,
    segmented: bool,
    large: bool,
    filed: bool,
}

/// The body key of a row: the content hash of a segmented body, else the inline body itself.
fn body_key(segmented: bool, content_hash: Option<&str>, compiled: &str, timeline: &str) -> String {
    if segmented {
        format!("s:{}", content_hash.unwrap_or(""))
    } else {
        format!("i:{compiled}\u{1}{timeline}")
    }
}

fn inline_bytes(v: &VersionRecord) -> i64 {
    i64::try_from(v.compiled_truth.len() + v.timeline.len()).unwrap_or(i64::MAX)
}

fn version_segmented(v: &VersionRecord) -> bool {
    v.body_storage.as_deref() == Some("segmented")
}

/// The version records of one page, by id.
fn page_versions(read: &dyn KvRead, page_id: u64) -> Result<Vec<VersionRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::version_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<VersionRecord>(v) {
            Ok(row) => out.push(row),
            Err(e) => failure = Some(e.into()),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    out.sort_by_key(|v| v.id);
    Ok(out)
}

/// The pick order: in force first; the latest in force, else the earliest later; then the most
/// recently recorded.
fn pick_order(a: &(bool, &EditionRow), b: &(bool, &EditionRow)) -> Ordering {
    let ((a_chosen, a), (b_chosen, b)) = (a, b);
    b_chosen
        .cmp(a_chosen)
        .then_with(|| {
            if *a_chosen {
                b.valid_from.cmp(&a.valid_from)
            } else {
                a.valid_from.cmp(&b.valid_from)
            }
        })
        .then_with(|| b.ord.cmp(&a.ord))
}

impl Store {
    /// `listValidTimeIdentities`: the live pages with `slug` in the source scope, under the page
    /// policy with `excludePrivate`, by source (byte order), at most six: the id, source, slug,
    /// file, the source's checkout and `world` (the no-caller page policy shows the page).
    pub fn list_valid_time_identities(&self, q: &ValidTimeIdentityQuery) -> Result<Vec<Value>> {
        const OP: &str = "listValidTimeIdentities";
        no_nul(OP, &[("slug", &q.slug)])?;
        let read = self.read()?;
        let mut sources: Vec<String> = Vec::new();
        for source in crate::sources::all_sources(&*read)? {
            if q.source_id.as_ref().is_some_and(|id| *id != source.id)
                || q.source_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&source.id))
            {
                continue;
            }
            sources.push(source.id);
        }
        sources.sort();
        let mut out = Vec::new();
        for source_id in sources {
            let Some(page) = crate::pages::read_page(&*read, &source_id, &q.slug)? else {
                continue;
            };
            if page.deleted_at_us.is_some() {
                continue;
            }
            if let Some(policy) = &q.exclude_private
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let local_path = read_source(&*read, &source_id)?.and_then(|s| s.local_path);
            out.push(json!({
                "id": page.id,
                "source_id": page.source_id,
                "slug": page.slug,
                "source_path": page.source_path,
                "local_path": local_path,
                "world": !page_hidden(&*read, &page, &q.world)?,
            }));
            if out.len() == IDENTITY_LIMIT {
                break;
            }
        }
        Ok(out)
    }

    /// The version `version_id` of page `page_id` with the fields an edition reads, or null when the
    /// page keeps no such version.
    pub fn read_page_version_edition(&self, q: &VersionEditionQuery) -> Result<Value> {
        let read = self.read()?;
        let (Ok(page_id), Ok(version_id)) = (u64::try_from(q.page_id), u64::try_from(q.version_id))
        else {
            return Ok(Value::Null);
        };
        let Some(v) =
            crate::get_json::<VersionRecord>(&*read, &keys::version(page_id, version_id))?
        else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "id": v.id,
            "title": v.title,
            "type": v.page_type,
            "tags": v.tags,
            "frontmatter": v.frontmatter,
            "compiled_truth": v.compiled_truth,
            "timeline": v.timeline,
            "revision": v.knowledge_revision,
            // PGLite's column defaults to `inline`; the record keeps the mark on a segmented snapshot only.
            "body_storage": v.body_storage.as_deref().unwrap_or("inline"),
            "body_generation": v.body_generation,
        }))
    }

    /// Whether the page (deleted or not) is still at the revision, and the newest version record at
    /// it; null when the page is gone.
    pub fn read_cursor_edition(&self, q: &CursorEditionQuery) -> Result<Value> {
        no_nul("readCursorEdition", &[("revision", &q.revision)])?;
        let read = self.read()?;
        let Some(page) = u64::try_from(q.page_id)
            .ok()
            .map(|id| read_page_by_id(&*read, id))
            .transpose()?
            .flatten()
        else {
            return Ok(Value::Null);
        };
        let version_id = page_versions(&*read, page.id)?
            .iter()
            .filter(|v| v.knowledge_revision == q.revision)
            .map(|v| v.id)
            .max();
        Ok(json!({ "current": page.knowledge_revision == q.revision, "version_id": version_id }))
    }

    /// `pickValidTimeEdition`: `{ row }`. `row` is null when no page has the id; otherwise the pick
    /// over the page's retained versions and the page (its pick columns null when no row carries a
    /// valid `valid_from`), the competing ordinals, the counts, the page's history gap and its
    /// creation time.
    pub fn pick_valid_time_edition(&self, q: &ValidTimePickQuery) -> Result<Value> {
        let read = self.read()?;
        let Some(page) = u64::try_from(q.page_id)
            .ok()
            .map(|id| read_page_by_id(&*read, id))
            .transpose()?
            .flatten()
        else {
            return Ok(json!({ "row": null }));
        };
        let versions = page_versions(&*read, page.id)?;
        let mut rows: Vec<EditionRow> = versions
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let segmented = version_segmented(v);
                // A reader held to world-visible pages sees the reason only when the next version
                // (over every version, never only the visible ones) is visible too; the last
                // version's successor is the page, which the caller's own page check covers.
                let successor_visible = versions
                    .get(i + 1)
                    .is_none_or(|n| !version_hidden(&n.page_type, &n.frontmatter, &q.policy));
                // A pruned successor's visibility can no longer be checked: that reason is withheld.
                let reason = v
                    .change_reason
                    .clone()
                    .filter(|_| !q.exclude_private || (successor_visible && !v.successor_pruned));
                EditionRow {
                    version_id: Some(v.id),
                    ord: i64::try_from(v.id).unwrap_or(i64::MAX),
                    replaced_at: Some(iso(v.snapshot_at_us)),
                    valid_from: valid_date(v.frontmatter.get("valid_from")),
                    valid_until: valid_date(v.frontmatter.get("valid_until")),
                    body_key: body_key(
                        segmented,
                        v.content_hash.as_deref(),
                        &v.compiled_truth,
                        &v.timeline,
                    ),
                    visible: !version_hidden(&v.page_type, &v.frontmatter, &q.policy),
                    reason,
                    successor_pruned: v.successor_pruned,
                    tier: TrustTier::stored(v.trust_tier.as_deref()).as_str(),
                    segmented,
                    large: !segmented && inline_bytes(v) > q.inline_max_bytes,
                    filed: v.source_path.is_some(),
                }
            })
            .collect();
        let segmented = segmented_reference(&*read, page.id)?.is_some();
        rows.push(EditionRow {
            version_id: None,
            ord: VALID_TIME_CURRENT_ORD,
            replaced_at: None,
            valid_from: valid_date(page.frontmatter.get("valid_from")),
            valid_until: valid_date(page.frontmatter.get("valid_until")),
            body_key: body_key(
                segmented,
                page.content_hash.as_deref(),
                &page.compiled_truth,
                &page.timeline,
            ),
            visible: !page_hidden(&*read, &page, &q.policy)?,
            reason: None,
            successor_pruned: false,
            tier: TrustTier::stored(page.trust_tier.as_deref()).as_str(),
            segmented,
            large: false,
            filed: page.source_path.is_some(),
        });
        rows.sort_by_key(|r| r.ord);
        let picked = rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.valid_from.is_some() && q.pin_ord.is_none_or(|pin| r.ord == pin))
            .map(|(i, r)| {
                (
                    r.valid_from
                        .as_deref()
                        .is_some_and(|vf| vf <= q.as_of.as_str()),
                    i,
                )
            })
            .min_by(|(a_chosen, a), (b_chosen, b)| {
                pick_order(&(*a_chosen, &rows[*a]), &(*b_chosen, &rows[*b]))
            });
        let mut row = Map::new();
        let null_pick = [
            "version_id",
            "ord",
            "replaced_at",
            "valid_from",
            "valid_until",
            "visible",
            "reason",
            "successor_pruned",
            "segmented",
            "recorded_since",
            "introduced_because",
            "chosen",
            "tier",
            "successor_tier",
            "competing",
        ];
        for key in null_pick {
            row.insert(key.to_string(), Value::Null);
        }
        if let Some((chosen, i)) = picked {
            let k = &rows[i];
            let prev = i.checked_sub(1).map(|p| &rows[p]);
            let next = rows.get(i + 1);
            let competing: Vec<i64> = rows
                .iter()
                .filter(|s| {
                    let (Some(vf), Some(kvf)) = (&s.valid_from, &k.valid_from) else {
                        return false;
                    };
                    let adjacent = prev.is_some_and(|p| p.ord == s.ord)
                        || next.is_some_and(|n| n.ord == s.ord);
                    s.ord != k.ord
                        && ((s.ord > k.ord && vf < kvf)
                            || (adjacent && s.body_key == k.body_key && vf != kvf))
                })
                .map(|s| s.ord)
                .take(5)
                .collect();
            row.insert("version_id".into(), json!(k.version_id));
            row.insert("ord".into(), json!(k.ord));
            row.insert("replaced_at".into(), json!(k.replaced_at));
            row.insert("valid_from".into(), json!(k.valid_from));
            row.insert("valid_until".into(), json!(k.valid_until));
            row.insert("visible".into(), json!(k.visible));
            row.insert("reason".into(), json!(k.reason));
            row.insert("successor_pruned".into(), json!(k.successor_pruned));
            row.insert("segmented".into(), json!(k.segmented));
            row.insert(
                "recorded_since".into(),
                json!(prev.and_then(|p| p.replaced_at.clone())),
            );
            // The reason that introduced the row: the previous row's, unless a prune cut the
            // previous row's successor, and counted only from a visible row when the read hides
            // private text.
            row.insert(
                "introduced_because".into(),
                json!(
                    prev.filter(|p| !p.successor_pruned && (!q.exclude_private || p.visible))
                        .and_then(|p| p.reason.clone())
                ),
            );
            row.insert("chosen".into(), json!(chosen));
            row.insert("tier".into(), json!(k.tier));
            row.insert("successor_tier".into(), json!(next.map(|n| n.tier)));
            row.insert(
                "competing".into(),
                if competing.is_empty() {
                    Value::Null
                } else {
                    json!(competing)
                },
            );
        }
        row.insert(
            "undated".into(),
            json!(rows.iter().filter(|r| r.valid_from.is_none()).count()),
        );
        row.insert(
            "large_versions".into(),
            json!(
                // Only a version is ever large.
                rows.iter().filter(|r| r.large).count()
            ),
        );
        row.insert(
            "segmented_versions".into(),
            json!(
                rows.iter()
                    .filter(|r| r.version_id.is_some() && r.segmented)
                    .count()
            ),
        );
        row.insert("any_filed".into(), json!(rows.iter().any(|r| r.filed)));
        row.insert(
            "gap_at".into(),
            json!(page.version_history_gap_at_us.map(iso)),
        );
        row.insert("created_at".into(), json!(iso(page.created_at_us)));
        Ok(json!({ "row": row }))
    }
}

#[cfg(test)]
mod tests {
    use super::valid_date;
    use serde_json::json;

    #[test]
    fn valid_date_accepts_a_calendar_date_at_utc_midnight_only() {
        let cases = [
            ("2026-01-01", Some("2026-01-01")),
            ("2026-01-01T00:00:00Z", Some("2026-01-01")),
            ("2026-01-01T00:00:00.000Z", Some("2026-01-01")),
            ("2026-01-01T00:00:00.0+00:00", Some("2026-01-01")),
            ("2026-01-01T00:00:00+00:00", Some("2026-01-01")),
            ("2028-02-29", Some("2028-02-29")),
            ("2000-02-29", Some("2000-02-29")),
            ("1000-01-01", Some("1000-01-01")),
            ("2026-04-30", Some("2026-04-30")),
            ("2026-12-31", Some("2026-12-31")),
            ("2026-02-29", None),
            ("1900-02-29", None),
            ("2026-02-30", None),
            ("2026-04-31", None),
            ("2026-13-01", None),
            ("2026-00-10", None),
            ("2026-01-00", None),
            ("0999-01-01", None),
            ("2026-01", None),
            ("2026", None),
            ("", None),
            ("soon", None),
            ("2026/01/01", None),
            ("2026-01-01T09:00:00Z", None),
            ("2026-01-01T00:00:00.Z", None),
            ("2026-01-01T00:00:00.001Z", None),
            ("2026-01-01T00:00:00", None),
            ("2026-01-01T00:00:00+01:00", None),
            ("2026-01-01 ", None),
            ("2026-1a-01", None),
        ];
        for (input, want) in cases {
            assert_eq!(
                (input, valid_date(Some(&json!(input))).as_deref()),
                (input, want)
            );
        }
        assert_eq!(valid_date(None), None);
        assert_eq!(valid_date(Some(&json!(20260101))), None);
    }
}
