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
//!   source. A fact is owner-only when its source is. Either row is also owner-only when its
//!   derivation inputs (`trust::derivation`, followed up to 8 hops) name a page or fact of an
//!   owner-only source, or a take or timeline entry whose page is in one ([`lineage_owner_only`]).

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::Result;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::pages::{PageRecord, read_page_by_id};
use crate::sources::{all_sources, read_source};
use crate::timeline_queries::jsonb_field_text;
use crate::trust::derivation::inputs_of;
use std::collections::HashSet;

/// The lineage hops `gbrain_owner_only_lineage` follows (`WHERE up.depth < 8`).
const LINEAGE_DEPTH: usize = 8;

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
/// positive row test implies the guard, so only the `closed` form reads every source.
pub(crate) fn page_owner_only(
    read: &dyn KvRead,
    page: &PageRecord,
    form: OwnerOnlyForm,
) -> Result<bool> {
    match form {
        OwnerOnlyForm::Off => Ok(false),
        OwnerOnlyForm::Closed => any_owner_only(read),
        OwnerOnlyForm::Fn => {
            if source_owner_only(read, &page.source_id)? {
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
            lineage_owner_only(read, "pages", page.id)
        }
    }
}

/// `ownerOnlyFactSql(alias, form)`: whether the fact `fact_id` of `source_id` counts as owner-only.
pub(crate) fn fact_owner_only(
    read: &dyn KvRead,
    fact_id: u64,
    source_id: &str,
    form: OwnerOnlyForm,
) -> Result<bool> {
    match form {
        OwnerOnlyForm::Off => Ok(false),
        OwnerOnlyForm::Closed => any_owner_only(read),
        OwnerOnlyForm::Fn => {
            Ok(source_owner_only(read, source_id)? || lineage_owner_only(read, "facts", fact_id)?)
        }
    }
}

/// The `WITH RECURSIVE up` walk of `gbrain_owner_only_lineage`: follows the derivation inputs of
/// `table`/`id` up to [`LINEAGE_DEPTH`] hops and finds an input with a numeric id (`^[0-9]{1,18}$`)
/// that is a page or fact of an owner-only source, or a take or timeline entry whose page is in one.
/// A row with no recorded inputs reads one key range.
pub(crate) fn lineage_owner_only(read: &dyn KvRead, table: &str, id: u64) -> Result<bool> {
    let mut frontier = vec![(table.to_string(), id.to_string())];
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for _ in 0..LINEAGE_DEPTH {
        let mut next = Vec::new();
        for (t, i) in &frontier {
            for input in inputs_of(read, t, i)? {
                if seen.insert(input.clone()) {
                    if input_owner_only(read, &input.0, &input.1)? {
                        return Ok(true);
                    }
                    next.push(input);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    Ok(false)
}

/// One `up` row's test: the input row exists and sits in (or on a page of) an owner-only source.
fn input_owner_only(read: &dyn KvRead, table: &str, id: &str) -> Result<bool> {
    let numeric = (1..=18).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
    let Some(id) = numeric.then(|| id.parse::<u64>().ok()).flatten() else {
        return Ok(false);
    };
    let page_source = |page_id: u64| -> Result<bool> {
        match read_page_by_id(read, page_id)? {
            Some(page) => source_owner_only(read, &page.source_id),
            None => Ok(false),
        }
    };
    match table {
        "pages" => page_source(id),
        "facts" => match crate::facts::read_fact(read, id)? {
            Some(fact) => source_owner_only(read, &fact.source_id),
            None => Ok(false),
        },
        "takes" => match crate::takes::read_take(read, id)? {
            Some(take) => page_source(take.page_id),
            None => Ok(false),
        },
        "timeline_entries" => match crate::timeline::entry_page_by_id(read, id)? {
            Some(page_id) => page_source(page_id),
            None => Ok(false),
        },
        _ => Ok(false),
    }
}
