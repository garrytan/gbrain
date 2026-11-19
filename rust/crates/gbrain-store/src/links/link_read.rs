//! The read options of the link reads (`getLinks`, `getBacklinks`, `traverseGraph`,
//! `traversePathsDetailed`): the caller's page policy (`excludePrivate`), the temporal edge policy
//! (`temporal`, `relationshipFilterSql` and the `temporalLinkJoinSql` annotation columns) and the
//! keyset page (`linkPageSql`) of `src/core/engine-sql/links.ts`.
//!
//! The page policy is the one the TypeScript shell read from `privatePagesFilterForCaller`
//! (`storePagePolicy`); a link passes it when both of its pages and its origin page pass. A read
//! under the policy judges temporal state by the `world` relationship rows, every other read by
//! the `all` rows. The temporal columns are returned raw (`temporal_*`); the shell annotates them
//! with `annotateTemporalRow`, as engine-sql's `finishTemporal` does.

use super::LinkRecord;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::KvRead;
use crate::link_queries::link_temporal::{
    RelationshipKey, RelationshipRecord, is_date, iso_ms, multirange_contains, multirange_overlaps,
    relationship, today,
};
use crate::pages::read_page_by_id;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

/// `LIVENESS_EXEMPT_LINK_TYPES`: types a live or `during` read never hides by their state.
const LIVENESS_EXEMPT: [&str; 1] = ["amends"];

/// `EdgeTemporalOpts`. `excludePrivate` inside it is ignored: every engine-sql read replaces it
/// with the read's own `excludePrivate`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeTemporal {
    pub status: Option<String>,
    pub as_of: Option<String>,
    pub during: Option<During>,
    pub exclude_private: Option<Value>,
    pub disabled: Option<bool>,
}

/// An overlap window `[from, until)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct During {
    pub from: String,
    pub until: String,
}

impl EdgeTemporal {
    fn status(&self) -> &str {
        self.status.as_deref().unwrap_or("live")
    }

    /// `relationshipFilterSql` returns `TRUE`: the policy keeps every edge.
    fn keeps_all(&self) -> bool {
        self.disabled == Some(true) || (self.status() == "all" && self.during.is_none())
    }

    /// `dateLiteral`: the dates `relationshipFilterSql` inlines, checked in the order it renders
    /// them.
    pub(crate) fn check_dates(&self) -> Result<()> {
        if self.keeps_all() {
            return Ok(());
        }
        let dates = self.as_of.iter().chain(
            self.during
                .iter()
                .flat_map(|d| [&d.from, &d.until].into_iter()),
        );
        for date in dates {
            if !is_date(date) {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!(
                        "temporal edge filter: invalid date {}",
                        serde_json::to_string(date).unwrap_or_default()
                    ),
                ));
            }
        }
        Ok(())
    }
}

/// `LinkReadPage.fromType`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FromType {
    #[serde(rename = "type")]
    pub page_type: String,
    pub alias_sources: Vec<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Keep {
    Match,
    Hidden,
}

/// `LinkReadPage.relationship`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelationshipKeep {
    pub policy: EdgeTemporal,
    pub keep: Keep,
}

/// `LinkReadPage`: a keyset page of link rows in link id order.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkPage {
    pub after_id: Option<i64>,
    pub through_id: Option<i64>,
    pub limit: Option<i64>,
    pub link_type: Option<String>,
    pub from_type: Option<FromType>,
    pub relationship: Option<RelationshipKeep>,
    pub context_chars: Option<i64>,
    pub count: Option<bool>,
}

impl LinkPage {
    pub(crate) fn check(&self) -> Result<()> {
        if self.limit.is_some_and(|n| n < 0) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                "LIMIT must not be negative",
            ));
        }
        match &self.relationship {
            Some(rel) => rel.policy.check_dates(),
            None => Ok(()),
        }
    }

    /// The `fromType` filter on the link's from page (`type` and source).
    pub(crate) fn source_type_ok(&self, page_type: &str, source_id: &str) -> bool {
        let Some(ft) = &self.from_type else {
            return true;
        };
        page_type == ft.page_type
            || (ft.page_type == "untyped" && page_type.is_empty())
            || ft
                .alias_sources
                .iter()
                .zip(ft.aliases.iter())
                .any(|(s, t)| s == source_id && t == page_type)
    }

    /// The link type and keyset bounds.
    pub(crate) fn bounds_ok(&self, link: &LinkRecord) -> bool {
        let id = link.id as i64;
        self.link_type.as_ref().is_none_or(|t| *t == link.link_type)
            && self.after_id.is_none_or(|a| id > a)
            && self.through_id.is_none_or(|t| id <= t)
    }

    /// `CASE WHEN char_length(context) > n THEN left(context, n - 1) || '…' ELSE context END`.
    pub(crate) fn context(&self, context: &str) -> String {
        let Some(chars) = self.context_chars else {
            return context.to_string();
        };
        let len = context.chars().count() as i64;
        if len <= chars {
            return context.to_string();
        }
        let n = chars - 1;
        let keep = if n >= 0 { n.min(len) } else { (len + n).max(0) };
        let mut cut: String = context.chars().take(keep as usize).collect();
        cut.push('…');
        cut
    }
}

/// The per-read edge rules: the page policy, the walk's temporal policy and the reference day.
pub(crate) struct EdgeRules<'a> {
    read: &'a dyn KvRead,
    privacy: Option<&'a PrivacyPolicy>,
    temporal: Option<&'a EdgeTemporal>,
    today: String,
    hidden: HashMap<u64, bool>,
}

impl<'a> EdgeRules<'a> {
    pub(crate) fn new(
        read: &'a dyn KvRead,
        privacy: Option<&'a PrivacyPolicy>,
        temporal: Option<&'a EdgeTemporal>,
        now_us: i64,
    ) -> Result<Self> {
        if let Some(t) = temporal {
            t.check_dates()?;
        }
        Ok(Self {
            read,
            privacy,
            temporal,
            today: today(now_us),
            hidden: HashMap::new(),
        })
    }

    /// The relationship rows a read judges: `world` under the page policy, else `all`.
    fn scope(&self) -> &'static str {
        if self.privacy.is_some() {
            "world"
        } else {
            "all"
        }
    }

    /// `privatePagesFilterForCaller` on the page with this id; true without a policy.
    pub(crate) fn page_ok(&mut self, id: u64) -> Result<bool> {
        let Some(policy) = self.privacy else {
            return Ok(true);
        };
        if let Some(hidden) = self.hidden.get(&id) {
            return Ok(!hidden);
        }
        let hidden = match read_page_by_id(self.read, id)? {
            Some(page) => page_hidden(self.read, &page, policy)?,
            None => true,
        };
        self.hidden.insert(id, hidden);
        Ok(!hidden)
    }

    /// `privateLinkOriginFilterForCaller`: no origin, or an origin the policy keeps.
    pub(crate) fn origin_ok(&mut self, link: &LinkRecord) -> Result<bool> {
        match link.origin_page_id {
            Some(origin) => self.page_ok(origin),
            None => Ok(true),
        }
    }

    /// The page policy on both pages and the origin of a link.
    pub(crate) fn link_private_ok(&mut self, link: &LinkRecord) -> Result<bool> {
        Ok(self.page_ok(link.from_page_id)?
            && self.page_ok(link.to_page_id)?
            && self.origin_ok(link)?)
    }

    fn relationship(&self, link: &LinkRecord) -> Result<Option<RelationshipRecord>> {
        relationship(self.read, &RelationshipKey::of_link(link), self.scope())
    }

    /// `temporalWalkFilter`: the walk's temporal policy keeps the link.
    pub(crate) fn walk_ok(&self, link: &LinkRecord) -> Result<bool> {
        match self.temporal {
            Some(policy) => self.matches(link, policy),
            None => Ok(true),
        }
    }

    /// `relationshipFilterSql(link, policy)`. Dates were checked when the policy was read.
    pub(crate) fn matches(&self, link: &LinkRecord, policy: &EdgeTemporal) -> Result<bool> {
        if policy.keeps_all() {
            return Ok(true);
        }
        let Some(state) = self.relationship(link)? else {
            return Ok(policy.during.is_some() || policy.status() != "ended");
        };
        let exempt = LIVENESS_EXEMPT.contains(&link.link_type.as_str());
        let day = policy.as_of.as_deref().unwrap_or(&self.today);
        if let Some(during) = &policy.during {
            return Ok(
                exempt || multirange_overlaps(&state.valid_ranges, &during.from, &during.until)
            );
        }
        if policy.status() == "ended" {
            return Ok(state.semantics == "state"
                && !multirange_contains(&state.valid_ranges, day)
                && state.first_start.as_deref().is_none_or(|f| f <= day));
        }
        let hidden = !multirange_contains(&state.valid_ranges, day)
            || (policy.as_of.is_some() && state.disputed);
        Ok(exempt || !hidden)
    }

    /// `TEMPORAL_LINK_SELECT_SQL` over `temporalLinkJoinSql`: the link's relationship row for the
    /// read's scope, every column null when it has none.
    pub(crate) fn temporal_columns(
        &self,
        link: &LinkRecord,
        row: &mut Map<String, Value>,
    ) -> Result<()> {
        let state = self.relationship(link)?;
        let col = |f: &dyn Fn(&RelationshipRecord) -> Value| state.as_ref().map_or(Value::Null, f);
        row.insert("temporal_ranges".into(), col(&|r| json!(r.valid_ranges)));
        row.insert("temporal_semantics".into(), col(&|r| json!(r.semantics)));
        row.insert("temporal_disputed".into(), col(&|r| json!(r.disputed)));
        row.insert(
            "temporal_undated_past".into(),
            col(&|r| json!(r.undated_past)),
        );
        row.insert(
            "temporal_first_start".into(),
            col(&|r| json!(r.first_start)),
        );
        row.insert(
            "temporal_recorded_at".into(),
            col(&|r| json!(iso_ms(r.recorded_at_us))),
        );
        row.insert(
            "temporal_retired_at".into(),
            col(&|r| json!(r.retired_at_us.map(iso_ms))),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_cut_follows_left() {
        let page = |n| LinkPage {
            context_chars: Some(n),
            ..LinkPage::default()
        };
        assert_eq!(page(5).context("abcdef"), "abcd…");
        assert_eq!(page(6).context("abcdef"), "abcdef");
        assert_eq!(page(1).context("abcdef"), "…");
        assert_eq!(page(0).context("abcdef"), "abcde…");
        assert_eq!(page(-10).context("abc"), "…");
        assert_eq!(page(3).context("éèêë"), "éè…");
        assert_eq!(LinkPage::default().context("abc"), "abc");
    }

    #[test]
    fn dates_are_checked_only_when_the_filter_renders_them() {
        let bad = EdgeTemporal {
            status: Some("all".into()),
            as_of: Some("2024-02-30".into()),
            ..EdgeTemporal::default()
        };
        assert!(bad.check_dates().is_ok());
        let live = EdgeTemporal {
            status: None,
            ..bad.clone()
        };
        let err = live.check_dates().unwrap_err();
        assert_eq!(
            err.message,
            "temporal edge filter: invalid date \"2024-02-30\""
        );
        let during = EdgeTemporal {
            status: Some("all".into()),
            as_of: None,
            during: Some(During {
                from: "2022-01-01".into(),
                until: "2023".into(),
            }),
            ..EdgeTemporal::default()
        };
        assert!(during.check_dates().is_err());
    }

    #[test]
    fn from_type_matches_stored_untyped_and_aliases() {
        let page = LinkPage {
            from_type: Some(FromType {
                page_type: "untyped".into(),
                alias_sources: vec!["s1".into()],
                aliases: vec!["person".into()],
            }),
            ..LinkPage::default()
        };
        assert!(page.source_type_ok("", "default"));
        assert!(page.source_type_ok("untyped", "default"));
        assert!(page.source_type_ok("person", "s1"));
        assert!(!page.source_type_ok("person", "default"));
    }
}
