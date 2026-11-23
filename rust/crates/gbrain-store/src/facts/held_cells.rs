//! The held fence cells of a world-only fact read: `listHeldFenceCells` (`engine-sql/cli-reads-ops.ts`,
//! `eligibility/fence-overlay.ts` `heldRowSql`), which `eligibility/stamp.ts` `heldFenceLines` asks before get_page,
//! get_chunks, think and search_exact show a page's text to a caller whose fact reads are world-only.
//!
//! A cell is one facts-fence row line of the text: the page (`source_id`, `slug`), its row number (-1 for a fragment
//! that names none), its claim and whether a chunk boundary cut it (`partial`). A cell is held when a live fact of the
//! page (`expired_at IS NULL`, by the by-page index on `source_markdown_slug`) that is narrower than world sits at its
//! row number, or when a live narrower fact of the page states its claim and no live world fact of the page states it.
//! A fact states a claim when it equals it, or, for a cut claim, contains it (`strpos(fact, claim) > 0`).
//!
//! A fact that is not world is narrower unless the caller's fact reads admit it:
//!
//! - The member admission (`memberFactAdmitSql`): with a member caller (`member`), a private fact on the caller's own
//!   member page (`memory/members/<member>`) while that page is live, its readers (`page_readers`) name the caller's
//!   principal and the caller's page policy (`privatePagesFilterForCaller`) shows it.
//! - The private-facts grant (`grantedPrivateFactSql`, GBRA-575): with grant sources (`grantSources`, the caller's
//!   `privateFactSources`), a private fact in one of those sources that has a holding page and no transcript-lane
//!   source (`unpagedFactSql`), and whose holding, provenance and entity pages are none of member, derivation-private
//!   in their stored row (deleted or not), missing or quarantined (`factPagesOpenSql`). The grant also needs every
//!   visibility proposal that names the fact (`supersede_fact` or `confirm`, a `visibility` key in `before_state`, any
//!   status) to target a fact the caller's reads admit by either rule, a copy the grant opens counting only when its
//!   own proposals pass too (the hold chain, `widen::hold_refused`).
//!
//! With neither, nothing is admitted. See rust/docs/store/facts.md, "Held fence cells".

use super::privacy::{PrivacyPolicy, access_readers, page_hidden};
use super::repair::{derivation_private, provenance_slug};
use super::widen::hold_refused;
use super::{FactRecord, MEMBER_PAGE_PREFIX, QUARANTINE_KEY, page_rows};
use crate::Store;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

/// One fence cell (`HeldFenceCellKey`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldFenceCellKey {
    pub source_id: String,
    pub slug: String,
    pub row_num: i64,
    pub claim: String,
    pub partial: bool,
}

/// `listHeldFenceCells({ keys })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldFenceCellsInput {
    pub keys: Vec<HeldFenceCellKey>,
    /// The member caller (`callerMember()`); none for a caller with no member identity.
    #[serde(default)]
    pub member: Option<HeldFenceMember>,
    /// The sources of the caller's private-facts grant (`privateFactSources()`); empty for a caller with none.
    #[serde(default, rename = "grantSources")]
    pub grant_sources: Vec<String>,
}

/// A member caller of `listHeldFenceCells`: its member page, its principal and its page policy.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldFenceMember {
    /// `memory/members/<member>` (`memberPageSlug`).
    pub slug: String,
    /// `member:<member>`, the principal the page's readers must name.
    pub principal: String,
    /// The caller's `privatePagesFilterForCaller` policy, which must show the member page.
    pub policy: PrivacyPolicy,
}

/// Whether `member` admits the private facts of page (`source`, `slug`): it is the member's own page, live, its
/// readers name the member's principal and the member's page policy shows it (`memberFactAdmitSql`).
fn member_admits(
    read: &dyn KvRead,
    member: Option<&HeldFenceMember>,
    source: &str,
    slug: &str,
) -> Result<bool> {
    let Some(member) = member.filter(|m| m.slug == slug) else {
        return Ok(false);
    };
    let Some(page) = read_page(read, source, slug)? else {
        return Ok(false);
    };
    if page.deleted_at_us.is_some()
        || !access_readers(&page.frontmatter)
            .is_some_and(|readers| readers.contains(&member.principal))
    {
        return Ok(false);
    }
    Ok(!page_hidden(read, &page, &member.policy)?)
}

/// `CASE WHEN partial THEN strpos(fact, claim) > 0 ELSE fact = claim END`.
fn states(row: &FactRecord, key: &HeldFenceCellKey) -> bool {
    if key.partial {
        row.fact.contains(key.claim.as_str())
    } else {
        row.fact == key.claim
    }
}

/// The transcript lanes (`transcriptLanesSql`): conversation extraction, capture hooks, the corpus sweep, transcripts
/// and connectors.
fn transcript_lane(source: &str) -> bool {
    source.starts_with(super::CONVERSATION_PREFIX)
        || matches!(source, "hook:writeback" | "hook:compact" | "sweep:corpus")
        || source.starts_with("transcript:")
        || source.starts_with("connector:")
}

/// Whether page (`source`, `slug`) keeps a fact private for the grant (`factPageReasons`): its stored row is
/// derivation-private, or it has no live row, or its live row is quarantined. `entity` is the entity page, which
/// only the first reason judges.
fn page_keeps_private(read: &dyn KvRead, source: &str, slug: &str, entity: bool) -> Result<bool> {
    let row = read_page(read, source, slug)?;
    // Both alias forms are derivation-private (`derivationPrivateSql` ORs `privacyAliasSql`), so the alias setting
    // does not change the answer.
    if row.as_ref().is_some_and(|p| derivation_private(p, true)) {
        return Ok(true);
    }
    if entity {
        return Ok(false);
    }
    Ok(match row.filter(|p| p.deleted_at_us.is_none()) {
        None => true,
        Some(p) => p.frontmatter.contains_key(QUARANTINE_KEY),
    })
}

/// `grantedPrivateFactSql(row)` for grant sources `sources`: a private fact of a granted source, with a page to check
/// (`unpagedFactSql` false) and none of its pages keeping it private (`factPagesOpenSql`).
fn grant_admits(read: &dyn KvRead, sources: &[String], row: &FactRecord) -> Result<bool> {
    if row.visibility != "private"
        || !sources.contains(&row.source_id)
        || transcript_lane(&row.source)
    {
        return Ok(false);
    }
    let Some(holding) = row.source_markdown_slug.as_deref() else {
        return Ok(false);
    };
    let provenance = provenance_slug(row);
    let member = |slug: Option<&str>| slug.is_some_and(|s| s.starts_with(MEMBER_PAGE_PREFIX));
    if member(Some(holding)) || member(row.entity_slug.as_deref()) || member(provenance.as_deref())
    {
        return Ok(false);
    }
    if page_keeps_private(read, &row.source_id, holding, false)? {
        return Ok(false);
    }
    if let Some(slug) = provenance.as_deref()
        && page_keeps_private(read, &row.source_id, slug, false)?
    {
        return Ok(false);
    }
    if let Some(slug) = row.entity_slug.as_deref()
        && page_keeps_private(read, &row.source_id, slug, true)?
    {
        return Ok(false);
    }
    Ok(true)
}

/// `memberFactAdmitSql(row)`: a private fact on a page `member` admits.
fn member_admits_fact(
    read: &dyn KvRead,
    member: Option<&HeldFenceMember>,
    row: &FactRecord,
) -> Result<bool> {
    match row.source_markdown_slug.as_deref() {
        Some(slug) if row.visibility == "private" => {
            member_admits(read, member, &row.source_id, slug)
        }
        _ => Ok(false),
    }
}

/// `heldRowSql`'s `granted(row)`: the grant admits the fact, and it is not a held row the grant refuses: every
/// visibility proposal that names it targets a fact the caller's reads admit, along the hold chain (a missing target,
/// or one in another table, keeps the fact narrower).
fn granted(read: &dyn KvRead, input: &HeldFenceCellsInput, row: &FactRecord) -> Result<bool> {
    if input.grant_sources.is_empty() || !grant_admits(read, &input.grant_sources, row)? {
        return Ok(false);
    }
    let member = |copy: &FactRecord| member_admits_fact(read, input.member.as_ref(), copy);
    let opens = |copy: &FactRecord| grant_admits(read, &input.grant_sources, copy);
    Ok(!hold_refused(read, row, &member, &opens)?)
}

/// A live fact of the page as `heldRowSql` reads it: the row and whether the caller's reads admit it.
pub(super) struct LiveRow {
    pub(super) row: FactRecord,
    pub(super) admitted: bool,
}

/// `heldRowSql` over the page's live rows. The fence overlay (`fence_overlay.rs`) passes rows no caller admits.
pub(super) fn held(rows: &[LiveRow], key: &HeldFenceCellKey, row_num: i32) -> bool {
    let narrower = |r: &&LiveRow| r.row.visibility != "world" && !r.admitted;
    rows.iter()
        .filter(|r| narrower(r))
        .any(|r| r.row.row_num == Some(row_num))
        || (rows
            .iter()
            .filter(|r| narrower(r))
            .any(|r| states(&r.row, key))
            && !rows
                .iter()
                .any(|r| r.row.visibility == "world" && states(&r.row, key)))
}

impl Store {
    /// `listHeldFenceCells({ keys, member, grantSources })`: `[{ source_id, slug, row_num, claim }]`, one row per distinct held cell, in the
    /// order of each cell's first key. A key with a NUL character or a row number outside `integer` is the error
    /// Postgres raises for the same parameters.
    pub fn list_held_fence_cells(&self, input: &HeldFenceCellsInput) -> Result<Vec<Value>> {
        let mut checked = Vec::with_capacity(input.keys.len());
        for key in &input.keys {
            no_nul(
                "listHeldFenceCells",
                &[
                    ("source_id", &key.source_id),
                    ("slug", &key.slug),
                    ("claim", &key.claim),
                ],
            )?;
            let row_num = i32::try_from(key.row_num).map_err(|_| {
                StoreError::new(
                    INVALID_ARGUMENT,
                    format!(
                        "listHeldFenceCells: row_num {} is out of range for type integer",
                        key.row_num
                    ),
                )
            })?;
            checked.push((key, row_num));
        }
        let read = self.read()?;
        let mut pages: HashMap<(&str, &str), Vec<LiveRow>> = HashMap::new();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (key, row_num) in checked {
            let page = (key.source_id.as_str(), key.slug.as_str());
            let live = match pages.entry(page) {
                Entry::Occupied(e) => e.into_mut(),
                Entry::Vacant(e) => {
                    let admit = member_admits(&*read, input.member.as_ref(), page.0, page.1)?;
                    let mut live = Vec::new();
                    for row in page_rows(&*read, page.0, page.1)? {
                        if row.expired_at_us.is_some() {
                            continue;
                        }
                        let admitted = row.visibility != "world"
                            && ((admit && row.visibility == "private")
                                || granted(&*read, input, &row)?);
                        live.push(LiveRow { row, admitted });
                    }
                    e.insert(live)
                }
            };
            if !held(live, key, row_num) {
                continue;
            }
            if seen.insert((page.0, page.1, row_num, key.claim.as_str())) {
                out.push(json!({
                    "source_id": key.source_id,
                    "slug": key.slug,
                    "row_num": row_num,
                    "claim": key.claim,
                }));
            }
        }
        Ok(out)
    }
}
