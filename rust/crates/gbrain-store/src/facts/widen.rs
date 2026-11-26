//! The per-row widening of a fact list read's `visibility` list: `factVisibilitySql`
//! (src/core/access/member-facts.ts). A list without `private` also admits a private fact on the
//! caller's own member page (`memberFactAdmitSql`) and a private fact in a source of the caller's
//! private-facts grant whose pages keep it private for no reason (`grantedPrivateFactSql`), unless
//! it is a held row the grant refuses ([`hold_refused`], GST-2979). The
//! TypeScript member sends this record only when the caller's rendered list equals the one for a
//! fresh record of the caller's reader identity, private-readable sources and grant
//! (store-members/fact-visibility.ts); rust/docs/store/facts.md names the rule of each test.

use super::privacy::{PrivacyPolicy, access_readers, page_hidden};
use super::repair::{derivation_private, provenance_slug};
use super::{FactRecord, read_fact};
use crate::Result;
use crate::kv::KvRead;
use crate::pages::read_page;
use crate::trust::proposals::visibility_proposal_targets;
use serde::Deserialize;
use std::collections::{HashSet, VecDeque};

/// `MEMBER_PAGE_PREFIX` (access/principals.ts).
const MEMBER_PAGE_PREFIX: &str = "memory/members/";

/// What widens the list, as the TypeScript member read it for the caller.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibilityWidening {
    /// `callerMember()`: the member whose own member page admits its private facts. None when no
    /// single member reads (`memberFactAdmitSql` is `FALSE`).
    pub member: Option<String>,
    /// The page policy that member page must pass (`privatePagesFilterForCaller('member_page')`).
    pub member_page_policy: Option<PrivacyPolicy>,
    /// `privateFactSources()`: the sources whose open private facts the caller reads.
    pub private_fact_sources: Vec<String>,
}

impl VisibilityWidening {
    /// Whether the widened list admits the private `row` (the caller checked the list first).
    pub(crate) fn admits(&self, read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
        if row.visibility != "private" {
            return Ok(false);
        }
        Ok(self.member_admits(read, row)? || self.grant_admits(read, row)?)
    }

    /// `memberFactAdmitSql`: the row sits on `memory/members/<member>`, whose live page names
    /// `member:<member>` among its readers and passes the member-page policy.
    pub(crate) fn member_admits(&self, read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
        let (Some(member), Some(policy)) = (&self.member, &self.member_page_policy) else {
            return Ok(false);
        };
        let own = format!("{MEMBER_PAGE_PREFIX}{member}");
        if row.source_markdown_slug.as_deref() != Some(own.as_str()) {
            return Ok(false);
        }
        let Some(page) = read_page(read, &row.source_id, &own)? else {
            return Ok(false);
        };
        let reader = format!("member:{member}");
        Ok(page.deleted_at_us.is_none()
            && access_readers(&page.frontmatter).is_some_and(|r| r.contains(&reader))
            && !page_hidden(read, &page, policy)?)
    }

    /// `grantedPrivateFactSql`: the grant opens the row ([`Self::grant_opens`]) and the row is
    /// not a held row the grant refuses ([`hold_refused`]).
    fn grant_admits(&self, read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
        if !self.grant_opens(read, row)? {
            return Ok(false);
        }
        let member = |copy: &FactRecord| -> Result<bool> {
            Ok(copy.visibility == "private" && self.member_admits(read, copy)?)
        };
        let opens = |copy: &FactRecord| self.grant_opens(read, copy);
        Ok(!hold_refused(read, row, &member, &opens)?)
    }

    /// `grantedPrivateFactSql`'s `opens(row)`: a private row whose source is granted, that has a
    /// page to check (`unpagedFactSql`), and none of whose pages keeps it private (`factPagesOpenSql`).
    fn grant_opens(&self, read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
        if row.visibility != "private"
            || !self.private_fact_sources.contains(&row.source_id)
            || unpaged(row)
        {
            return Ok(false);
        }
        Ok(!kept_private(read, row)?)
    }
}

/// `grantedPrivateFactSql`'s `held_refused` (GST-2979): whether `row` is a held row the grant
/// refuses. A held row is the related row of a visibility proposal (`supersede_fact` or `confirm`
/// whose `before_state` has a `visibility` key, any status). It is refused when one of those
/// proposals targets a copy that is missing (or not a fact), or that the caller's reads admit by
/// neither the member rule (`member`) nor the grant's open test (`opens`); and, along the hold
/// chain, when a copy that only the grant opens is itself refused. `opens` is the grant test
/// without the hold, as the SQL's `opens(held_copy)` is. The same rule judges the page overlay's
/// held cells (`held_cells.rs` `granted`, `heldRowSql`).
pub(super) fn hold_refused(
    read: &dyn KvRead,
    row: &FactRecord,
    member: &dyn Fn(&FactRecord) -> Result<bool>,
    opens: &dyn Fn(&FactRecord) -> Result<bool>,
) -> Result<bool> {
    let mut seen = HashSet::from([row.id]);
    let mut held = VecDeque::from([row.id]);
    while let Some(id) = held.pop_front() {
        for (table, target) in visibility_proposal_targets(read, id)? {
            let copy = match u64::try_from(target) {
                Ok(target) if table == "facts" => read_fact(read, target)?,
                _ => None,
            };
            let Some(copy) = copy else {
                return Ok(true);
            };
            if member(&copy)? {
                continue;
            }
            if !opens(&copy)? {
                return Ok(true);
            }
            if seen.insert(copy.id) {
                held.push_back(copy.id);
            }
        }
    }
    Ok(false)
}

/// `unpagedFactSql`: no holding page, or a transcript lane (conversation extraction, the capture
/// hooks, the corpus sweep, transcripts and connectors).
fn unpaged(row: &FactRecord) -> bool {
    let source = row.source.as_str();
    row.source_markdown_slug.is_none()
        || source.starts_with("cli:extract-conversation-facts")
        || matches!(source, "hook:writeback" | "hook:compact" | "sweep:corpus")
        || source.starts_with("transcript:")
        || source.starts_with("connector:")
}

/// `NOT factPagesOpenSql`: the row is held on, provenanced from or about a member page, or one of
/// `factPageReasons` holds: its holding or provenance page is derivation-private (in any row with
/// the slug, deleted or not), missing or quarantined, or its entity page is derivation-private.
fn kept_private(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let provenance = provenance_slug(row);
    let slugs = [
        row.source_markdown_slug.as_deref(),
        row.entity_slug.as_deref(),
        provenance.as_deref(),
    ];
    if slugs
        .iter()
        .flatten()
        .any(|s| s.starts_with(MEMBER_PAGE_PREFIX))
    {
        return Ok(true);
    }
    for slug in [row.source_markdown_slug.as_deref(), provenance.as_deref()]
        .into_iter()
        .flatten()
    {
        match read_page(read, &row.source_id, slug)? {
            // The privacy aliases count whether or not they are honoured (`derivationPrivateSql`).
            Some(page) if derivation_private(read, &page, false)? => return Ok(true),
            Some(page) if page.deleted_at_us.is_some() => return Ok(true),
            Some(page) if page.frontmatter.contains_key(super::QUARANTINE_KEY) => return Ok(true),
            Some(_) => {}
            None => return Ok(true),
        }
    }
    if let Some(entity) = &row.entity_slug
        && let Some(page) = read_page(read, &row.source_id, entity)?
        && derivation_private(read, &page, false)?
    {
        return Ok(true);
    }
    Ok(false)
}

/// The visibility test of a list read: the row's visibility is listed (no list lists all), or the
/// widening admits it.
pub(crate) fn visibility_admits(
    read: &dyn KvRead,
    list: &Option<Vec<String>>,
    widen: &Option<VisibilityWidening>,
    row: &FactRecord,
) -> Result<bool> {
    if list
        .as_ref()
        .is_none_or(|l| l.iter().any(|v| v == &row.visibility))
    {
        return Ok(true);
    }
    match widen {
        Some(widen) => widen.admits(read, row),
        None => Ok(false),
    }
}

/// A world-only read (`worldOnly`, `factVisibilitySql(alias, ['world'])`): a world row, or a private row `widen` admits.
pub(crate) fn world_admits(
    read: &dyn KvRead,
    widen: &Option<VisibilityWidening>,
    row: &FactRecord,
) -> Result<bool> {
    if row.visibility == "world" {
        return Ok(true);
    }
    match widen {
        Some(widen) => widen.admits(read, row),
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(source: &str, slug: Option<&str>) -> FactRecord {
        FactRecord {
            source: source.into(),
            source_markdown_slug: slug.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn a_fact_with_no_holding_page_or_from_a_transcript_lane_is_unpaged() {
        assert!(unpaged(&row("fence", None)));
        for lane in [
            "cli:extract-conversation-facts:v2",
            "hook:writeback",
            "hook:compact",
            "sweep:corpus",
            "transcript:chat",
            "connector:gmail",
        ] {
            assert!(unpaged(&row(lane, Some("notes/a"))), "{lane}");
        }
        assert!(!unpaged(&row("fence", Some("notes/a"))));
        assert!(!unpaged(&row("hook:writebacks", Some("notes/a"))));
    }

    #[test]
    fn a_widening_record_reads_camel_case_and_refuses_unknown_fields() {
        let w: VisibilityWidening = serde_json::from_value(serde_json::json!({
            "member": "alice-example",
            "memberPagePolicy": { "honorAliases": true, "entityPrivacy": true },
            "privateFactSources": ["default"],
        }))
        .unwrap();
        assert_eq!(w.member.as_deref(), Some("alice-example"));
        assert_eq!(w.private_fact_sources, ["default"]);
        assert!(
            serde_json::from_value::<VisibilityWidening>(
                serde_json::json!({ "honorAliases": true })
            )
            .is_err()
        );
    }
}
