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
//! - `closed` (the closed test of a read with no schema version: `ANY_OWNER_ONLY_SQL` or the held
//!   flag, GST-3032): while any source is owner-only, or the brain has held owner-only data (a mark,
//!   here), every row counts as owner-only.
//! - `fn` (`gbrain_owner_only_lineage`, schema migration v320, its `_strict` read of the
//!   `owner_only_marks` of migration v322, and its v328 form with the login's read mode, which is
//!   always the exact lineage here: the store has no logins whose reads row security narrows): the guard (any owner-only source or any mark) and the
//!   row test. A page is owner-only when its source is, when `owner_only_marks` names it (a hard
//!   delete of its owner-only input marked it, `owner_only_marks.rs`), or when it is a concept or a
//!   question with a `concept-provenance` / `synthesized_from` link to a page in an owner-only
//!   source. A fact is owner-only when its source is (the store marks no fact rows). The SQL
//!   function also follows `derivation_inputs` up to 8 hops; the store keeps no derivation inputs
//!   (that table is written only through raw SQL, which a Rust brain refuses), so that walk finds
//!   nothing here.
//!
//! This is the one owner-only implementation: [`OwnerOnlySources`] holds the rule, a read that
//! judges many pages reads the sources once into it, and [`fact_owner_only`] is the one-shot
//! form for a fact.

use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

use crate::Result;
use crate::facts::concept_inputs;
use crate::kv::KvRead;
use crate::owner_only_marks::{any_marked, is_marked};
use crate::pages::PageRecord;
use crate::sources::{all_sources, read_source};
use crate::timeline_queries::jsonb_field_text;

/// `OwnerOnlyForm` (access/owner-only.ts): which form of the owner-only test the policy renders.
/// A policy that names none takes `closed`, the form that hides the most.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerOnlyForm {
    /// No owner-only test.
    Off,
    /// `gbrain_owner_only_lineage(table, id)` behind its guard (the strict read of the marks).
    /// Master's member names this form `lineage` (`StoreOwnerOnly` in master's
    /// store-members/private-provenance.ts: the v320 form and its v328 read-mode form), so the
    /// store reads that name as this form too.
    #[serde(alias = "lineage")]
    Fn,
    /// The closed test: any owner-only source, or the held flag (a mark, here), hides every row.
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

/// `ownerOnlyFactSql(alias, form)`: whether a fact of `source_id` counts as owner-only.
pub(crate) fn fact_owner_only(
    read: &dyn KvRead,
    source_id: &str,
    form: OwnerOnlyForm,
) -> Result<bool> {
    match form {
        OwnerOnlyForm::Off => Ok(false),
        OwnerOnlyForm::Closed => Ok(any_owner_only(read)? || any_marked(read)?),
        OwnerOnlyForm::Fn => source_owner_only(read, source_id),
    }
}

/// The ids of the owner-only sources (`isOwnerOnlySourceConfig`), read once per query and passed
/// to the page tests.
pub(crate) struct OwnerOnlySources {
    ids: HashSet<String>,
    /// A row was marked owner-only when its origin was deleted (`owner_only_marks`), so the guard
    /// stays on.
    marked: bool,
}

impl OwnerOnlySources {
    pub(crate) fn read(read: &dyn KvRead) -> Result<Self> {
        let mut ids = HashSet::new();
        for source in all_sources(read)? {
            if owner_only_config(&source.config) {
                ids.insert(source.id);
            }
        }
        Ok(Self {
            ids,
            marked: any_marked(read)?,
        })
    }

    fn holds(&self, source_id: &str) -> bool {
        self.ids.contains(source_id)
    }

    /// `gbrain_owner_only_lineage()`: the brain holds an owner-only source or a mark, so the
    /// per-row test runs at all.
    pub(crate) fn guarded(&self) -> bool {
        !self.ids.is_empty() || self.marked
    }

    /// `gbrain_owner_only_lineage_strict('pages', id)`: marked, held in an owner-only source, or a
    /// concept or question with a `concept-provenance` input page in one. The `derivation_inputs`
    /// walk has no table here.
    pub(crate) fn lineage_strict(&self, read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
        if is_marked(read, page.id)? || self.holds(&page.source_id) {
            return Ok(true);
        }
        if matches!(page.page_type.as_str(), "concept" | "question") {
            for input in concept_inputs(read, page)? {
                if self.holds(&input.source_id) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// `ownerOnlyPageSql(alias, form)` for a caller that is not the owner.
    pub(crate) fn page_hidden(
        &self,
        read: &dyn KvRead,
        page: &PageRecord,
        form: OwnerOnlyForm,
    ) -> Result<bool> {
        match form {
            OwnerOnlyForm::Off => Ok(false),
            OwnerOnlyForm::Closed => Ok(self.guarded()),
            OwnerOnlyForm::Fn => Ok(self.guarded() && self.lineage_strict(read, page)?),
        }
    }

    /// `ownerOnlyFactSql(facts, form)` for a caller that is not the owner: a fact held in an
    /// owner-only source is hidden, or every fact is while the brain holds an owner-only source or a
    /// mark (the closed form). The store marks no fact rows and keeps no `derivation_inputs`.
    pub(crate) fn fact_hidden(&self, form: OwnerOnlyForm, source_id: &str) -> bool {
        match form {
            OwnerOnlyForm::Off => false,
            OwnerOnlyForm::Closed => self.guarded(),
            OwnerOnlyForm::Fn => self.holds(source_id),
        }
    }
}

#[cfg(test)]
mod wire_tests {
    use super::OwnerOnlyForm;
    use serde_json::json;

    fn form(name: &str) -> Result<OwnerOnlyForm, serde_json::Error> {
        serde_json::from_value(json!(name))
    }

    #[test]
    fn master_s_lineage_name_reads_as_the_function_form() {
        assert_eq!(form("lineage").unwrap(), OwnerOnlyForm::Fn);
        assert_eq!(form("fn").unwrap(), OwnerOnlyForm::Fn);
        assert_eq!(form("closed").unwrap(), OwnerOnlyForm::Closed);
        assert_eq!(form("off").unwrap(), OwnerOnlyForm::Off);
        // A name neither side sends still refuses, so a new form is not read as an old one.
        assert!(form("mode").is_err());
        assert!(form("Lineage").is_err());
    }
}
