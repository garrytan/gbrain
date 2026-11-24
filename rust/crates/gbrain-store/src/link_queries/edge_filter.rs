//! The temporal edge filter of the walks: `relationshipFilterSql` (`src/core/link-validity.ts`) over
//! the store's relationship state rows (`link_temporal.rs`). A walk step keeps an edge only while
//! its relationship matches the caller's temporal policy.
//!
//! An edge passes when its relationship has no state row for the read scope (a reference type, or
//! not yet refreshed), when its type is liveness-exempt (outside `ended` reads), or when its state
//! row matches the requested status on the reference day.
//!
//! Keys: this module adds none.

use super::link_temporal::{
    DateRange, RelationshipKey, RelationshipRecord, parse_multirange, relationship,
};
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::LinkRecord;
use serde::Deserialize;

/// `LIVENESS_EXEMPT_LINK_TYPES`: the types whose relationship never ends a live read.
const LIVENESS_EXEMPT: [&str; 1] = ["amends"];

/// `EdgeTemporalOpts.during`: the overlap window `[from, until)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DuringWindow {
    pub from: String,
    pub until: String,
}

/// `EdgeTemporalOpts`, with `excludePrivate` set from the walk's own `excludePrivate` as
/// `temporalWalkFilter` sets it: true reads the `world` state row, false the `all` row.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EdgeTemporalPolicy {
    /// `live` (the default), `ended` or `all`.
    pub status: Option<String>,
    /// The reference day, `YYYY-MM-DD`; today (UTC) when absent.
    pub as_of: Option<String>,
    pub during: Option<DuringWindow>,
    pub exclude_private: bool,
    pub disabled: bool,
}

/// `valid_ranges @> day`. Ranges are half-open: lower inclusive, upper exclusive, `None` unbounded.
fn contains(ranges: &[DateRange], day: &str) -> bool {
    ranges.iter().any(|(lo, hi)| {
        lo.as_deref().is_none_or(|l| l <= day) && hi.as_deref().is_none_or(|u| day < u)
    })
}

/// `valid_ranges && daterange(from, until)`.
fn overlaps(ranges: &[DateRange], from: &str, until: &str) -> bool {
    from < until
        && ranges.iter().any(|(lo, hi)| {
            lo.as_deref().is_none_or(|l| l < until) && hi.as_deref().is_none_or(|u| from < u)
        })
}

fn exempt(row: &RelationshipRecord) -> bool {
    LIVENESS_EXEMPT.contains(&row.link_type.as_str())
}

/// Whether `link` passes `relationshipFilterSql(alias, policy)` with `today` as `now()`'s UTC date.
pub(crate) fn edge_passes(
    read: &dyn KvRead,
    link: &LinkRecord,
    policy: &EdgeTemporalPolicy,
    today: &str,
) -> Result<bool> {
    let status = policy.status.as_deref().unwrap_or("live");
    if policy.disabled || (status == "all" && policy.during.is_none()) {
        return Ok(true);
    }
    let scope = if policy.exclude_private {
        "world"
    } else {
        "all"
    };
    let day = policy.as_of.as_deref().unwrap_or(today);
    let row = relationship(read, &RelationshipKey::of_link(link), scope)?;
    if let Some(during) = &policy.during {
        return Ok(match row {
            Some(r) if !exempt(&r) => overlaps(
                &parse_multirange(&r.valid_ranges)?,
                &during.from,
                &during.until,
            ),
            _ => true,
        });
    }
    if status == "ended" {
        return Ok(match row {
            Some(r) if r.semantics == "state" => {
                !contains(&parse_multirange(&r.valid_ranges)?, day)
                    && r.first_start.as_deref().is_none_or(|s| s <= day)
            }
            _ => false,
        });
    }
    Ok(match row {
        Some(r) if !exempt(&r) => {
            contains(&parse_multirange(&r.valid_ranges)?, day)
                && !(policy.as_of.is_some() && r.disputed)
        }
        _ => true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_answer_contains_and_overlaps() {
        let r = parse_multirange("{[2021-04-01,2025-03-01),[2026-01-01,)}").unwrap();
        assert!(contains(&r, "2021-04-01"));
        assert!(!contains(&r, "2025-03-01"));
        assert!(!contains(&r, "2025-06-01"));
        assert!(contains(&r, "2030-01-01"));
        assert!(overlaps(&r, "2025-01-01", "2025-04-01"));
        assert!(!overlaps(&r, "2025-03-01", "2026-01-01"));
        assert!(!overlaps(&r, "2027-01-01", "2027-01-01"));
        assert!(!contains(&parse_multirange("{}").unwrap(), "2020-01-01"));
        assert!(contains(
            &parse_multirange("{(,2020-01-01)}").unwrap(),
            "1900-01-01"
        ));
    }
}
