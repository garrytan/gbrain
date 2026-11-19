//! Owner-only sources (src/core/access/owner-only.ts): a source whose config holds
//! `owner_only: true`, or whose `kind` is always owner-only (`imessage`), is read only by the
//! owner. Every page and fact policy PGLite renders for a caller that is not the owner ends with
//! the owner-only test (`ownerOnlyAllowedSql` and `ownerOnlyFactAllowedSql` in
//! src/core/search/private-visibility.ts). The TypeScript member reads which form the rendered
//! text holds and sends it as [`OwnerOnlyForm`]; an owner read renders no test, and the member
//! refuses it before the store reads.
//!
//! - `off`: the rendered text holds no owner-only test (a policy rendered for the owner, such as
//!   the evidence-origin policy of a write run by the owner).
//! - `closed` (`ANY_OWNER_ONLY_SQL`, a read with no schema version): while any source is
//!   owner-only, every row counts as owner-only.
//! - `fn` (`gbrain_owner_only_lineage`, schema migration v320): the guard (any owner-only source)
//!   and the row test. A page is owner-only when its source is, or when it is a concept or a
//!   question with a `concept-provenance` / `synthesized_from` link to a page in an owner-only
//!   source, or when `owner_only_marks` names it (`gbrain_owner_only_lineage_strict`, v322: the
//!   mark a hard delete of its owner-only input leaves, owner_only_marks.rs). A fact is
//!   owner-only when its source is. The SQL function also follows
//!   `derivation_inputs` up to 8 hops; the store keeps no derivation inputs (that table is written
//!   only through raw SQL, which a Rust brain refuses), so that walk finds nothing here.

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::Result;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::owner_only_marks::is_marked;
use crate::pages::{PageRecord, read_page_by_id};
use crate::sources::{all_sources, read_source};
use crate::timeline_queries::jsonb_field_text;

/// `OwnerOnlyForm` (access/owner-only.ts): which form of the owner-only test the policy renders.
/// A policy that names none takes `closed`, the form that hides the most.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerOnlyForm {
    /// No owner-only test.
    Off,
    /// `gbrain_owner_only_lineage(table, id)` behind its guard.
    Fn,
    /// `ANY_OWNER_ONLY_SQL`: any owner-only source hides every row.
    #[default]
    Closed,
}

/// `OWNER_ONLY_KINDS`: source kinds that are owner-only whatever their flag says.
const OWNER_ONLY_KINDS: &[&str] = &["imessage"];

/// `ownerOnlySourceRowSql`: `config->>'kind' IN OWNER_ONLY_KINDS OR config->>'owner_only' = 'true'`.
pub(crate) fn owner_only_config(config: &Map<String, Value>) -> bool {
    let text = |key: &str| config.get(key).and_then(jsonb_field_text);
    text("kind").is_some_and(|kind| OWNER_ONLY_KINDS.contains(&kind.as_str()))
        || text("owner_only").as_deref() == Some("true")
}

/// `ANY_OWNER_ONLY_SQL`: the brain holds an owner-only source.
pub(crate) fn any_owner_only(read: &dyn KvRead) -> Result<bool> {
    Ok(all_sources(read)?
        .iter()
        .any(|s| owner_only_config(&s.config)))
}

/// `ownerOnlySourceSql`: the source `source_id` is owner-only. A missing source is not.
pub(crate) fn source_owner_only(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    Ok(read_source(read, source_id)?.is_some_and(|s| owner_only_config(&s.config)))
}

/// `ownerOnlyPageSql(alias, form)`: whether `page` counts as owner-only. In the `fn` form a
/// positive row test implies the guard (an owner-only source or a mark exists), so only the
/// `closed` form reads every source.
pub(crate) fn page_owner_only(
    read: &dyn KvRead,
    page: &PageRecord,
    form: OwnerOnlyForm,
) -> Result<bool> {
    match form {
        OwnerOnlyForm::Off => Ok(false),
        OwnerOnlyForm::Closed => any_owner_only(read),
        OwnerOnlyForm::Fn => {
            if is_marked(read, page.id)? || source_owner_only(read, &page.source_id)? {
                return Ok(true);
            }
            if !matches!(page.page_type.as_str(), "concept" | "question") {
                return Ok(false);
            }
            for link in out_links(read, page.id)? {
                if link.link_source.as_deref() == Some("concept-provenance")
                    && link.link_type == "synthesized_from"
                    && let Some(input) = read_page_by_id(read, link.to_page_id)?
                    && source_owner_only(read, &input.source_id)?
                {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}

/// `ownerOnlyFactSql(alias, form)`: whether a fact of `source_id` counts as owner-only.
pub(crate) fn fact_owner_only(
    read: &dyn KvRead,
    source_id: &str,
    form: OwnerOnlyForm,
) -> Result<bool> {
    match form {
        OwnerOnlyForm::Off => Ok(false),
        OwnerOnlyForm::Closed => any_owner_only(read),
        OwnerOnlyForm::Fn => source_owner_only(read, source_id),
    }
}
