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

/// The calendar date a frontmatter value declares, as the pick reads it (`validDateSql` in
/// src/core/valid-time.ts, the SQL twin of `validDate`), or `None`.
///
/// Two forms count, as `DAY_FORM` and `STAMP_FORM` there:
/// - a day `YYYY-MM-DD`, a real calendar date from year 1000, kept as written;
/// - a timestamp `YYYY-M-D`, then `T`, `t` or a run of spaces and tabs, `H:MM:SS`, an optional `.`
///   with digits, and an optional zone (spaces or tabs, then `Z` or `+H`, `+HH`, `+HH:MM`, or the
///   same with `-`). The written day must be a real calendar date from year 1000. The instant is
///   built as js-yaml builds it (the first three fraction digits are milliseconds, a field out of
///   range rolls over, the zone is subtracted); it must be midnight UTC on a day of a year from 1000
///   to 9999 (`BETWEEN 1000 AND 9999`), and that day is the answer. A day that rolls into year 10000
///   is no date, as in `validDate`.
pub(crate) fn valid_date(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?;
    let mut c = Cursor {
        b: s.as_bytes(),
        i: 0,
    };
    let year = c.digits(4, 4)?;
    c.byte(b'-')?;
    let (month_at, month) = (c.i, c.digits(1, 2)?);
    c.byte(b'-')?;
    let (day_at, day) = (c.i, c.digits(1, 2)?);
    if !in_calendar(year, month, day) {
        return None;
    }
    if c.done() {
        // `DAY_FORM`: two-digit month and day, no time.
        return (c.i - day_at == 2 && day_at - month_at == 3).then(|| s.to_string());
    }
    if !c.eat(|b| b == b'T' || b == b't') && c.run(|b| b == b' ' || b == b'\t') == 0 {
        return None;
    }
    let hour = c.digits(1, 2)?;
    c.byte(b':')?;
    let minute = c.digits(2, 2)?;
    c.byte(b':')?;
    let second = c.digits(2, 2)?;
    let mut millis = 0;
    if c.eat(|b| b == b'.') {
        let at = c.i;
        c.run(|b| b.is_ascii_digit());
        let fraction = &s[at..c.i];
        millis = format!("{:0<3}", &fraction[..fraction.len().min(3)])
            .parse::<i64>()
            .ok()?;
    }
    let mut zone_minutes = 0;
    if !c.done() {
        c.run(|b| b == b' ' || b == b'\t');
        if !c.eat(|b| b == b'Z') {
            let sign = match c.b.get(c.i) {
                Some(b'+') => 1,
                Some(b'-') => -1,
                _ => return None,
            };
            c.i += 1;
            let zone_hour = c.digits(1, 2)?;
            let zone_minute = if c.eat(|b| b == b':') {
                c.digits(2, 2)?
            } else {
                0
            };
            zone_minutes = sign * (zone_hour * 60 + zone_minute);
        }
        if !c.done() {
            return None;
        }
    }
    let instant = days_from_civil(year, month, day) * DAY_MS
        + ((hour * 60 + minute) * 60 + second) * 1000
        + millis
        - zone_minutes * 60_000;
    if instant.rem_euclid(DAY_MS) != 0 {
        return None;
    }
    let (y, m, d) = civil_from_days(instant.div_euclid(DAY_MS));
    (1000..=9999)
        .contains(&y)
        .then(|| format!("{y:04}-{m:02}-{d:02}"))
}

const DAY_MS: i64 = 86_400_000;

/// A left-to-right reader over the bytes of one value.
struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cursor<'_> {
    fn done(&self) -> bool {
        self.i == self.b.len()
    }

    /// Takes one byte that passes `ok`.
    fn eat(&mut self, ok: impl Fn(u8) -> bool) -> bool {
        let hit = self.b.get(self.i).is_some_and(|&b| ok(b));
        self.i += usize::from(hit);
        hit
    }

    fn byte(&mut self, want: u8) -> Option<()> {
        self.eat(|b| b == want).then_some(())
    }

    /// Takes every byte that passes `ok`, and says how many.
    fn run(&mut self, ok: impl Fn(u8) -> bool) -> usize {
        let at = self.i;
        while self.eat(&ok) {}
        self.i - at
    }

    /// Takes `min..=max` ASCII digits (as many as there are, up to `max`) and reads them.
    fn digits(&mut self, min: usize, max: usize) -> Option<i64> {
        let at = self.i;
        while self.i - at < max && self.eat(|b| b.is_ascii_digit()) {}
        if self.i - at < min {
            return None;
        }
        std::str::from_utf8(&self.b[at..self.i]).ok()?.parse().ok()
    }
}

/// A real calendar day of a year from 1000 (`inCalendar`).
fn in_calendar(year: i64, month: i64, day: i64) -> bool {
    year >= 1000 && (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The proleptic Gregorian date of a day count from 1970-01-01 (H. Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
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
                let successor_visible = versions.get(i + 1).is_none_or(|n| {
                    !version_hidden(&page, &n.page_type, &n.frontmatter, &q.policy)
                });
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
                    visible: !version_hidden(&page, &v.page_type, &v.frontmatter, &q.policy),
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
    fn valid_date_answers_what_the_sql_pick_answers() {
        let cases = [
            // Every row is what `validDateSql` (src/core/valid-time.ts at PR 9908, af0ec1146e) answers on PGLite.
            ("2026-01-01", Some("2026-01-01")),
            ("2026-01-01T00:00:00Z", Some("2026-01-01")),
            ("2026-01-01T00:00:00.000Z", Some("2026-01-01")),
            ("2026-01-01T00:00:00.0+00:00", Some("2026-01-01")),
            ("2026-01-01T00:00:00+00:00", Some("2026-01-01")),
            ("2026-01-01T00:00:00", Some("2026-01-01")),
            ("2026-01-01T00:00:00.000", Some("2026-01-01")),
            ("2026-01-01t00:00:00Z", Some("2026-01-01")),
            ("2026-01-01t00:00:00", Some("2026-01-01")),
            ("2026-01-01t00:00:00.0+00:00", Some("2026-01-01")),
            ("2026-01-01 00:00:00", Some("2026-01-01")),
            ("2026-01-01 00:00:00Z", Some("2026-01-01")),
            ("2026-01-01 00:00:00+00:00", Some("2026-01-01")),
            ("2026-01-01 00:00:00.000+00:00", Some("2026-01-01")),
            ("2026-02-29 00:00:00", None),
            ("0999-01-01 00:00:00", None),
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
            ("2026-01-01 12:00:00", None),
            ("2026-01-01T00:00:00.Z", Some("2026-01-01")),
            ("2026-01-01T00:00:00.001Z", None),
            ("2026-01-01T00:00:00.", Some("2026-01-01")),
            ("2026-01-01T00:00:00+01:00", None),
            ("2026-01-01T00:00:00z", None),
            ("2026-01-01T00:00:00+00", Some("2026-01-01")),
            ("2026-01-01T00:00:00-00:00", Some("2026-01-01")),
            ("2026-01-01 00:00:00 +00:00", Some("2026-01-01")),
            ("2026-01-01T02:00:00+02:00", Some("2026-01-01")),
            ("2026-01-02T00:00:00+02:00", None),
            ("2026-01-01  00:00:00", Some("2026-01-01")),
            ("2026-01-01\t00:00:00", Some("2026-01-01")),
            ("2026-01-01x00:00:00", None),
            ("2026-01-01T0:00:00", Some("2026-01-01")),
            ("2026-01-01 ", None),
            ("2026-01-01T", None),
            ("2026-01-01 00:00:00\n", None),
            ("2026-1a-01", None),
            ("2026-02-01", Some("2026-02-01")),
            ("2026-02-01T00:00:00Z", Some("2026-02-01")),
            ("2026-02-01 00:00:00 +00:00", Some("2026-02-01")),
            ("2026-02-01T00:00:00+00", Some("2026-02-01")),
            ("2026-02-01T00:00:00-00:00", Some("2026-02-01")),
            ("2026-02-01T02:00:00+02:00", Some("2026-02-01")),
            ("2026-2-1T00:00:00Z", Some("2026-02-01")),
            ("2026-02-01\t00:00:00", Some("2026-02-01")),
            ("2026-01-31T22:00:00-02:00", Some("2026-02-01")),
            ("2026-02-01T00:00:00.0001Z", Some("2026-02-01")),
            ("2026-02-01T0:00:00Z", Some("2026-02-01")),
            ("2026-02-01  00:00:00", Some("2026-02-01")),
            ("2026-02-01T00:00:00 Z", Some("2026-02-01")),
            ("2026-02-01T00:00:00.Z", Some("2026-02-01")),
            ("2026-02-01T00:00:00.", Some("2026-02-01")),
            ("2026-01-31T24:00:00Z", Some("2026-02-01")),
            ("2026-02-01T00:60:00+01:00", Some("2026-02-01")),
            ("2026-02-01T02:00:00+2", Some("2026-02-01")),
            ("2026-02-01T00:00:00+00:00", Some("2026-02-01")),
            ("2026-02-01T01:00:00Z", None),
            ("2026-02-01T00:00:00+01:00", None),
            ("2026-02-01T00:00:00.5Z", None),
            ("2026-02-01T00:00:00z", None),
            ("2026-02-01T12:00:00Z", None),
            ("2026-02-30T00:00:00Z", None),
            ("2026-02-01T00:00:00+0100", None),
            ("2026-02-01 00:00:00\n", None),
            // A rollover into year 10000 is no date, in validDate and validDateSql alike.
            ("9999-12-31T24:00:00Z", None),
            ("9999-12-31T23:00:00-01:00", None),
            ("1000-01-01T00:00:00+00:30", None),
            ("1000-01-01T00:00:00-24:00", Some("1000-01-02")),
            ("0999-12-31T24:00:00Z", None),
            ("2026-02-01 \t 00:00:00", Some("2026-02-01")),
            ("2026-02-01T00:00:00\t+00:00", Some("2026-02-01")),
            ("2026-02-01T00:00:00+00:", None),
            ("2026-02-01T99:99:99Z", None),
            ("2026-02-01x00:00:00", None),
            ("2026-02-01T", None),
            ("2026-02-01T00:00:00.999Z", None),
            ("2026-02-01T00:00:00.0009Z", Some("2026-02-01")),
            ("2026-02-01T00:00:00Z ", None),
            (" 2026-02-01", None),
            ("2026-12-31T23:59:60Z", Some("2027-01-01")),
            ("2026-02-01t00:00:00 -00", Some("2026-02-01")),
            ("20260-02-01T00:00:00Z", None),
            ("9999-12-31T00:00:00Z", Some("9999-12-31")),
            ("2026-02-01T00:00:00-0:00", Some("2026-02-01")),
            ("2026-02-01T00:00:00+00:0", None),
            ("2026-02-01T00:00:00+100", None),
            ("2026-123-01T00:00:00Z", None),
            ("2026-02-01T123:00:00Z", None),
            ("2026-02-01T00:0:00Z", None),
            ("2026-02-01 \t", None),
            ("2026-02-01T00:00:00 ", None),
            ("2026-2-1", None),
            ("2026-02-1", None),
            ("1969-12-31T24:00:00Z", Some("1970-01-01")),
            ("2026-02-01T00:00:00.000000000Z", Some("2026-02-01")),
            ("2026-02-01TT00:00:00Z", None),
            ("2026-02-01T 00:00:00Z", None),
            ("2026-02-01T00:00:00Z+00:00", None),
            ("2024-03-01T01:30:00+01:30", Some("2024-03-01")),
            ("2024-02-29T23:00:00-01:00", Some("2024-03-01")),
            ("2024-03-01T00:00:00.000000Z", Some("2024-03-01")),
            ("1000-01-01T01:00:00+01:00", Some("1000-01-01")),
            ("2024-03-01T00:00:01Z", None),
            ("2024-03-01T00:60:00Z", None),
            ("2024-13-01", None),
            ("2024-03", None),
            ("nope", None),
            ("9999-12-31T72:00:00Z", None),
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
