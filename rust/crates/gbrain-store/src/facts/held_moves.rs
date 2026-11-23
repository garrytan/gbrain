//! The held-fact move and facts-home reads (src/core/engine-sql/facts-purge.ts `held-fact-move.ts` section and
//! facts-cycle.ts): the facts a holding page (`memory/unattributed`, at any folder depth) keeps for an entity that has
//! no page yet, and the scans the facts home reports from.
//!
//! Shared rules, read from the SQL:
//!
//! - `onHolding` is a row of the source with a fence position and no ontology dimension, about an entity that is no
//!   holding page, whose `source_markdown_slug` names a holding page that has a row in the source (a soft-deleted
//!   page counts: the SQL tests only for the page row).
//! - The access reads (`readHeldAccessState`, `heldMoveDue`) read the folder rules and pending coverage `access_rules.rs`
//!   keeps (`gbrain_access_folder_rules`, `gbrain_access_pending_covers`); the access state is always readable (no
//!   row-level security).
//! - A text comparison is a byte comparison, and a NUL byte in a text argument is refused whether or not a row would
//!   match, as Postgres refuses the bound parameter.

use super::privacy::holding_slug;
use super::purge::fence_columns;
use super::{FactRecord, PrivacyPolicy, page_hidden, source_rows};
use crate::Store;
use crate::access_rules::{folder_rules, has_exact_prefix, pending_covers};
use crate::env::{is_uuid, iso};
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `heldEntityPageDeleted`, `heldTargetPageLive`, `readHeldPageLocation` and `readHeldAccessState` (its entity is the
/// `slug`): one page of a source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldPageArgs {
    pub source_id: String,
    pub slug: String,
}

/// `readHeldRowVisibility(sourceId, slug)` with the page policy the TypeScript member judged the caller by.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldVisibilityArgs {
    pub source_id: String,
    pub slug: String,
    pub policy: PrivacyPolicy,
}

/// `listHeldFactRows(sourceId, days)`: `days` is the interval text the SQL appends ` days` to.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldAgeArgs {
    pub source_id: String,
    pub days: String,
}

/// Whether `row` is a held row of `source_id` (`onHolding` in facts-purge.ts).
fn on_holding(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let Some(slug) = row.source_markdown_slug.as_deref() else {
        return Ok(false);
    };
    let about_other = row.entity_slug.as_deref().is_some_and(|e| !holding_slug(e));
    if !(holding_slug(slug) && row.row_num.is_some() && row.dimension.is_none() && about_other) {
        return Ok(false);
    }
    Ok(read_page(read, &row.source_id, slug)?.is_some())
}

/// `EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = entity_slug AND deleted_at IS [NOT] NULL)`.
fn page_state(read: &dyn KvRead, row: &FactRecord) -> Result<(bool, bool)> {
    let Some(entity) = row.entity_slug.as_deref() else {
        return Ok((false, false));
    };
    Ok(match read_page(read, &row.source_id, entity)? {
        Some(page) => (page.deleted_at_us.is_none(), page.deleted_at_us.is_some()),
        None => (false, false),
    })
}

/// The columns a held row carries before the page flags: the fact's identity, its text, then the fence columns.
fn base_columns(r: &FactRecord) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("id".into(), json!(r.id));
    row.insert("source_id".into(), json!(r.source_id));
    row.insert("entity_slug".into(), json!(r.entity_slug));
    row.insert("fact".into(), json!(r.fact));
    fence_columns(&mut row, r);
    row
}

/// The `days` text as the micros `($2 || ' days')::interval` is: an optionally signed decimal number. Another interval
/// text is refused (the TypeScript member refuses it before it asks), and so is one too large for an interval.
fn days_micros(days: &str) -> Result<i64> {
    let bad = || {
        StoreError::invalid(format!(
            "listHeldFactRows: days {days:?} is not a plain number"
        ))
    };
    let (negative, digits) = match days.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, days.strip_prefix('+').unwrap_or(days)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let plain = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty()
        || whole.len() > 6
        || fraction.len() > 6
        || !plain(whole)
        || !plain(fraction)
    {
        return Err(bad());
    }
    let whole: i64 = whole.parse().map_err(|_| bad())?;
    let fraction: i64 = if fraction.is_empty() {
        0
    } else {
        // 86_400_000_000 micros a day, so each digit of the fraction is a whole number of micros at most six places deep.
        let scale = 10_i64.pow(fraction.len() as u32);
        fraction.parse::<i64>().map_err(|_| bad())? * (86_400_000_000 / scale)
    };
    let micros = whole * 86_400_000_000 + fraction;
    Ok(if negative { -micros } else { micros })
}

/// `outcome->'held_versions_edited'->>'segmented_versions_not_edited'` as `::int`; 0 for none.
fn edited_count(outcome: Option<&Value>) -> Result<i64> {
    let Some(Value::Object(held)) = outcome.and_then(|o| o.get("held_versions_edited")) else {
        return Ok(0);
    };
    let text = match held.get("segmented_versions_not_edited") {
        None | Some(Value::Null) => return Ok(0),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    text.trim().parse::<i32>().map(i64::from).map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type integer: \"{text}\""))
    })
}

impl Store {
    /// `heldEntityPageDeleted(sourceId, slug)`: whether the entity's page exists and is soft-deleted.
    pub fn held_entity_page_deleted(&self, q: &HeldPageArgs) -> Result<bool> {
        no_nul(
            "heldEntityPageDeleted",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, &q.source_id, &q.slug)?.is_some_and(|p| p.deleted_at_us.is_some()))
    }

    /// `heldTargetPageLive(sourceId, slug)`: whether a live page holds the slug.
    pub fn held_target_page_live(&self, q: &HeldPageArgs) -> Result<bool> {
        no_nul(
            "heldTargetPageLive",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, &q.source_id, &q.slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
    }

    /// `readHeldAccessState(sourceId, entity)`: the one row of the access state: whether it is unreadable (never, the
    /// store has no row-level security), whether a rule or pending prefix is exactly the entity, and whether a folder
    /// rule or pending prefix covers it. The entity is the page args' `slug`.
    pub fn read_held_access_state(&self, q: &HeldPageArgs) -> Result<Vec<Value>> {
        no_nul(
            "readHeldAccessState",
            &[("sourceId", &q.source_id), ("entity", &q.slug)],
        )?;
        let unreadable = self.read_access_state_unreadable()?;
        let read = self.read()?;
        let page_rule = has_exact_prefix(&*read, &q.source_id, &q.slug)?;
        let restricted = !folder_rules(&*read, &q.source_id, &q.slug)?.is_empty()
            || pending_covers(&*read, &q.source_id, &q.slug)?;
        Ok(vec![
            json!({ "unreadable": unreadable, "page_rule": page_rule, "restricted": restricted }),
        ])
    }

    /// `listHeldMoveRows(sourceId)`: every live held row on every holding page, by holding page, entity, then id.
    pub fn list_held_move_rows(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("listHeldMoveRows", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for r in source_rows(&*read, source_id)? {
            if r.expired_at_us.is_none() && on_holding(&*read, &r)? {
                rows.push(r);
            }
        }
        rows.sort_by(|a, b| {
            (&a.source_markdown_slug, &a.entity_slug, a.id).cmp(&(
                &b.source_markdown_slug,
                &b.entity_slug,
                b.id,
            ))
        });
        Ok(rows
            .iter()
            .map(|r| {
                let mut row = base_columns(r);
                row.insert("page_exists".into(), json!(true));
                row.insert("from_slug".into(), json!(r.source_markdown_slug));
                Value::Object(row)
            })
            .collect())
    }

    /// `listStruckHeldRows(sourceId)`: one expired held row for each holding page and row number that no active fact
    /// reuses: the newest by id, by holding page then row number.
    pub fn list_struck_held_rows(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("listStruckHeldRows", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let all = source_rows(&*read, source_id)?;
        let active: std::collections::BTreeSet<(&String, i32)> = all
            .iter()
            .filter(|r| r.expired_at_us.is_none())
            .filter_map(|r| Some((r.source_markdown_slug.as_ref()?, r.row_num?)))
            .collect();
        let mut newest: std::collections::BTreeMap<(&String, i32), &FactRecord> =
            Default::default();
        for r in &all {
            let (Some(slug), Some(num)) = (r.source_markdown_slug.as_ref(), r.row_num) else {
                continue;
            };
            if r.expired_at_us.is_none() || active.contains(&(slug, num)) || !on_holding(&*read, r)?
            {
                continue;
            }
            let best = newest.entry((slug, num)).or_insert(r);
            if r.id > best.id {
                *best = r;
            }
        }
        Ok(newest
            .into_iter()
            .map(|((slug, num), r)| {
                json!({ "from_slug": slug, "entity_slug": r.entity_slug, "row_num": num, "fact": r.fact })
            })
            .collect())
    }

    /// `readHeldRowVisibility(sourceId, slug)`: `{ visible }` for the live page under the world page policy, null for
    /// none.
    pub fn read_held_row_visibility(&self, q: &HeldVisibilityArgs) -> Result<Option<Value>> {
        no_nul(
            "readHeldRowVisibility",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let Some(page) =
            read_page(&*read, &q.source_id, &q.slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(None);
        };
        Ok(Some(
            json!({ "visible": !page_hidden(&*read, &page, &q.policy)? }),
        ))
    }

    /// `heldMoveDue(sourceId)`: whether a rule narrows a held row's entity below its holding page: the entity's folder
    /// rule ids are not all among the holding page's, or a pending prefix covers the entity and not the holding page.
    /// Expired rows count: the SQL does not filter them.
    pub fn held_move_due(&self, source_id: &str) -> Result<bool> {
        no_nul("heldMoveDue", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let rule_ids = |slug: &str| -> Result<BTreeSet<String>> {
            Ok(folder_rules(&*read, source_id, slug)?
                .into_iter()
                .map(|r| r.rule_id)
                .collect())
        };
        for r in source_rows(&*read, source_id)? {
            if !on_holding(&*read, &r)? {
                continue;
            }
            let (Some(entity), Some(holding)) =
                (r.entity_slug.as_deref(), r.source_markdown_slug.as_deref())
            else {
                continue;
            };
            if !rule_ids(entity)?.is_subset(&rule_ids(holding)?)
                || (pending_covers(&*read, source_id, entity)?
                    && !pending_covers(&*read, source_id, holding)?)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `readHeldConfigValue(name)`: one config value, null when unset (`getConfig`'s answer).
    pub fn read_held_config_value(&self, name: &str) -> Result<Option<String>> {
        self.get_config(name)
    }

    /// `readHeldPageLocation(sourceId, slug)`: the live page's file path and URI, null for none.
    pub fn read_held_page_location(&self, q: &HeldPageArgs) -> Result<Option<Value>> {
        no_nul(
            "readHeldPageLocation",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, &q.source_id, &q.slug)?
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| json!({ "source_path": p.source_path, "source_uri": p.source_uri })))
    }

    /// `readHeldVersionsEdited(requestId)`: the segmented versions the request recorded as not edited, 0 when it
    /// recorded none or no request has the id. A request id more than one principal used answers from the first admitted.
    pub fn read_held_versions_edited(&self, request_id: &str) -> Result<i64> {
        if !is_uuid(request_id) {
            return Err(StoreError::invalid(format!(
                "readHeldVersionsEdited: invalid input syntax for type uuid: \"{request_id}\""
            )));
        }
        let wanted = request_id.to_lowercase();
        let read = self.read()?;
        let mut first: Option<(u64, Option<Value>)> = None;
        scan_prefix(&*read, &[keys::REQUEST], false, &mut |_, v| {
            if let Ok(r) = serde_json::from_slice::<crate::journal::RequestRecord>(v)
                && r.request_id.to_lowercase() == wanted
                && first
                    .as_ref()
                    .is_none_or(|(sequence, _)| r.sequence < *sequence)
            {
                first = Some((r.sequence, r.outcome));
            }
            true
        })?;
        edited_count(first.as_ref().and_then(|(_, outcome)| outcome.as_ref()))
    }

    /// `scanUnfencedFactRows(sourceId)`: the unexpired rows with no fence position, by entity (none first), then id,
    /// with their ontology dimension and whether the entity page is live or soft-deleted.
    pub fn scan_unfenced_fact_rows(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("scanUnfencedFactRows", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut rows: Vec<FactRecord> = source_rows(&*read, source_id)?
            .into_iter()
            .filter(|r| r.row_num.is_none() && r.expired_at_us.is_none())
            .collect();
        rows.sort_by(|a, b| (&a.entity_slug, a.id).cmp(&(&b.entity_slug, b.id)));
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let (exists, deleted) = page_state(&*read, r)?;
            let mut row = base_columns(r);
            row.insert("dimension".into(), json!(r.dimension));
            row.insert("page_exists".into(), json!(exists));
            row.insert("page_deleted".into(), json!(deleted));
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `listHeldFactRows(sourceId, days)`: the unexpired held rows, by entity then id, with when each started waiting
    /// (UTC, to the second) and whether that is more than `days` days ago.
    pub fn list_held_fact_rows(&self, q: &HeldAgeArgs) -> Result<Vec<Value>> {
        no_nul(
            "listHeldFactRows",
            &[("sourceId", &q.source_id), ("days", &q.days)],
        )?;
        let cutoff = self.env.now_micros() - days_micros(&q.days)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for r in source_rows(&*read, &q.source_id)? {
            if r.expired_at_us.is_none() && on_holding(&*read, &r)? {
                rows.push(r);
            }
        }
        rows.sort_by(|a, b| (&a.entity_slug, a.id).cmp(&(&b.entity_slug, b.id)));
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let mut row = base_columns(r);
            row.insert("page_exists".into(), json!(page_state(&*read, r)?.0));
            row.insert("from_slug".into(), json!(r.source_markdown_slug));
            // `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` cuts the fraction of a second.
            row.insert(
                "held_since".into(),
                json!(format!("{}Z", &iso(r.created_at_us)[..19])),
            );
            row.insert("old".into(), json!(r.created_at_us < cutoff));
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `listFencedFactsOfMissingPages(sourceId)`: `{ id, slug }` for each unexpired fenced row whose page is missing or
    /// soft-deleted, by id.
    pub fn list_fenced_facts_of_missing_pages(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("listFencedFactsOfMissingPages", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut out = Vec::new();
        let mut rows = source_rows(&*read, source_id)?;
        rows.sort_by_key(|r| r.id);
        for r in rows
            .iter()
            .filter(|r| r.row_num.is_some() && r.expired_at_us.is_none())
        {
            let live = match r.source_markdown_slug.as_deref() {
                Some(slug) => {
                    read_page(&*read, source_id, slug)?.is_some_and(|p| p.deleted_at_us.is_none())
                }
                None => false,
            };
            if !live {
                out.push(json!({ "id": r.id, "slug": r.source_markdown_slug }));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::{days_micros, edited_count};
    use serde_json::json;

    #[test]
    fn days_are_the_interval_a_plain_number_names() {
        assert_eq!(days_micros("30").unwrap(), 30 * 86_400_000_000);
        assert_eq!(days_micros("1.5").unwrap(), 129_600_000_000);
        assert_eq!(days_micros("-1").unwrap(), -86_400_000_000);
        assert_eq!(days_micros("0").unwrap(), 0);
        for bad in ["", "-", "1 hour", "1e2", "1.0000001", ".5", "1234567"] {
            assert!(days_micros(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_edited_count_is_the_integer_the_outcome_names_and_zero_for_none() {
        let n = |o: serde_json::Value| edited_count(Some(&o));
        assert_eq!(edited_count(None).unwrap(), 0);
        assert_eq!(n(json!({})).unwrap(), 0);
        assert_eq!(n(json!({ "held_versions_edited": {} })).unwrap(), 0);
        assert_eq!(
            n(json!({ "held_versions_edited": { "segmented_versions_not_edited": 3 } })).unwrap(),
            3
        );
        assert_eq!(
            n(json!({ "held_versions_edited": { "segmented_versions_not_edited": " 4 " } }))
                .unwrap(),
            4
        );
        assert!(
            n(json!({ "held_versions_edited": { "segmented_versions_not_edited": 3.5 } })).is_err()
        );
        assert!(n(json!({ "held_versions_edited": { "segmented_versions_not_edited": 3_000_000_000_i64 } })).is_err());
    }
}
