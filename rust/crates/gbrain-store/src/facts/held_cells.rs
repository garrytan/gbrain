//! The held fence cells of a world-only fact read: `listHeldFenceCells` (`engine-sql/cli-reads-ops.ts`,
//! `eligibility/fence-overlay.ts` `heldRowSql`), which `eligibility/stamp.ts` `heldFenceLines` asks before get_page,
//! get_chunks, think and search_exact show a page's text to a caller whose fact reads are world-only.
//!
//! A cell is one facts-fence row line of the text: the page (`source_id`, `slug`), its row number (-1 for a fragment
//! that names none), its claim and whether a chunk boundary cut it (`partial`). The store answers a caller with no
//! private-facts grant, the form in which `heldRowSql` renders `grantedPrivateFactSql` as `FALSE` (the TypeScript
//! member refuses a grant). A cell is held when a live fact of the page (`expired_at IS NULL`, by the by-page index on
//! `source_markdown_slug`) that is narrower than world sits at its row number, or when a live narrower fact of the page
//! states its claim and no live world fact of the page states it. A fact states a claim when it equals it, or, for a
//! cut claim, contains it (`strpos(fact, claim) > 0`).
//!
//! A fact that is not world is narrower unless the caller's member admission takes it (`memberFactAdmitSql`): with a
//! member caller (`member`), a private fact on the caller's own member page (`memory/members/<member>`) while that page
//! is live, its readers (`page_readers`) name the caller's principal and the caller's page policy
//! (`privatePagesFilterForCaller`) shows it. With no member caller nothing is admitted.
//! See rust/docs/store/facts.md, "Held fence cells".

use super::privacy::{PrivacyPolicy, access_readers, page_hidden};
use super::{FactRecord, page_rows};
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

/// `heldRowSql` with the grant `FALSE`, over the page's live rows; `admit` is the member admission of the page.
fn held(rows: &[FactRecord], key: &HeldFenceCellKey, row_num: i32, admit: bool) -> bool {
    let narrower =
        |r: &&FactRecord| r.visibility != "world" && !(admit && r.visibility == "private");
    rows.iter()
        .filter(narrower)
        .any(|r| r.row_num == Some(row_num))
        || (rows.iter().filter(narrower).any(|r| states(r, key))
            && !rows
                .iter()
                .any(|r| r.visibility == "world" && states(r, key)))
}

impl Store {
    /// `listHeldFenceCells({ keys, member })`: `[{ source_id, slug, row_num, claim }]`, one row per distinct held cell, in the
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
        let mut pages: HashMap<(&str, &str), (Vec<FactRecord>, bool)> = HashMap::new();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (key, row_num) in checked {
            let page = (key.source_id.as_str(), key.slug.as_str());
            let (live, admit) = match pages.entry(page) {
                Entry::Occupied(e) => e.into_mut(),
                Entry::Vacant(e) => e.insert((
                    page_rows(&*read, page.0, page.1)?
                        .into_iter()
                        .filter(|r| r.expired_at_us.is_none())
                        .collect(),
                    member_admits(&*read, input.member.as_ref(), page.0, page.1)?,
                )),
            };
            if !held(live, key, row_num, *admit) {
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
