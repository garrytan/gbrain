//! The quote reads of a fact surface (src/core/engine-sql/facts-trust.ts): `listFactsFromQuotedPages`
//! and `listOwnerTierFacts`. search/transcript-quote.ts fences the facts these name before a model
//! reads them.
//!
//! A fact is from a quoted page through the page that holds it (`source_markdown_slug`), a page a
//! `derivation_inputs` edge of the fact names ([`derivation_page_id`]: input table `pages`, an id
//! of 1 to 18 digits, in any source, as the SQL join on `p.id` does), or the page a backstop fact's
//! `source_session` names (the first `(source, prefix)` pair whose source is the fact's and whose
//! prefix starts the session, as the SQL `CASE` tries them). Each page may be soft-deleted: the
//! SQL reads every `pages` row.

use super::{FactRecord, read_fact};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::generations::inputs_of;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::{read_page, read_page_by_id};
use crate::trust::TrustTier;
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotedPagesQuery {
    pub ids: Vec<u64>,
    pub page_types: Vec<String>,
    /// `[source, session prefix]` pairs: a fact saved by `source` whose `source_session` starts
    /// with the prefix names the page slug after it.
    pub backstop: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerTierQuery {
    pub ids: Vec<u64>,
    pub floor: String,
}

/// The fact rows of `ids` that exist, in ascending id order, each once.
fn fact_rows(read: &dyn KvRead, ids: &[u64]) -> Result<Vec<FactRecord>> {
    let mut out = Vec::new();
    for id in ids.iter().copied().collect::<BTreeSet<u64>>() {
        if let Some(row) = read_fact(read, id)? {
            out.push(row);
        }
    }
    Ok(out)
}

/// A page row of `source_id` at `slug` (deleted too) whose type is one of `types`.
fn page_of_type(read: &dyn KvRead, source_id: &str, slug: &str, types: &[String]) -> Result<bool> {
    Ok(read_page(read, source_id, slug)?.is_some_and(|p| types.contains(&p.page_type)))
}

/// The slug a backstop fact's `source_session` names: after the prefix of the first `backstop`
/// pair whose source is the fact's and whose prefix starts the session.
fn backstop_slug<'a>(row: &'a FactRecord, backstop: &[(String, String)]) -> Option<&'a str> {
    let session = row.source_session.as_deref()?;
    backstop
        .iter()
        .filter(|(source, _)| *source == row.source)
        .find_map(|(_, prefix)| session.strip_prefix(prefix.as_str()))
}

/// The page id a `derivation_inputs` edge names, as the SQL reads it: input table `pages` and an
/// `input_id` that matches `^[0-9]{1,18}$`, cast to `bigint` (leading zeros allowed). Any other
/// edge names no page.
fn derivation_page_id(table: &str, id: &str) -> Option<u64> {
    let digits = (1..=18).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
    if table != "pages" || !digits {
        return None;
    }
    id.parse().ok()
}

/// A page a `derivation_inputs` edge of fact `id` names has a type in `types`.
fn derived_from_page_of_type(read: &dyn KvRead, id: u64, types: &[String]) -> Result<bool> {
    for (table, input) in inputs_of(read, "facts", &id.to_string())? {
        if let Some(page_id) = derivation_page_id(&table, &input)
            && read_page_by_id(read, page_id)?.is_some_and(|p| types.contains(&p.page_type))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    /// `listFactsFromQuotedPages`: the ids of `ids` whose holding page, a derivation input page,
    /// or the page a backstop session names, has a type in `pageTypes`; ascending. A NUL in a page
    /// type is refused as a text parameter refuses it.
    pub fn list_facts_from_quoted_pages(&self, q: &QuotedPagesQuery) -> Result<Vec<u64>> {
        for t in &q.page_types {
            no_nul("listFactsFromQuotedPages", &[("pageTypes", t)])?;
        }
        let read = self.read()?;
        let types = &q.page_types;
        let mut out = Vec::new();
        for row in fact_rows(&*read, &q.ids)? {
            let held = match row.source_markdown_slug.as_deref() {
                Some(slug) => page_of_type(&*read, &row.source_id, slug, types)?,
                None => false,
            };
            let quoted = held
                || derived_from_page_of_type(&*read, row.id, types)?
                || match backstop_slug(&row, &q.backstop) {
                    Some(slug) => page_of_type(&*read, &row.source_id, slug, types)?,
                    None => false,
                };
            if quoted {
                out.push(row.id);
            }
        }
        Ok(out)
    }

    /// `listOwnerTierFacts`: the ids of `ids` whose stored tier ranks at or above `floor`;
    /// ascending. An empty id list reads nothing; a floor that names no tier is refused, as
    /// engine-sql/facts-trust.ts `assertOwnerTierFloor` refuses it.
    pub fn list_owner_tier_facts(&self, q: &OwnerTierQuery) -> Result<Vec<u64>> {
        if q.ids.is_empty() {
            return Ok(Vec::new());
        }
        let floor = TrustTier::parse(&q.floor).ok_or_else(|| {
            StoreError::invalid(format!(
                "listOwnerTierFacts: unknown trust tier {:?}",
                q.floor
            ))
        })?;
        let read = self.read()?;
        Ok(fact_rows(&*read, &q.ids)?
            .into_iter()
            .filter(|row| row.tier().rank() >= floor.rank())
            .map(|row| row.id)
            .collect())
    }
}
