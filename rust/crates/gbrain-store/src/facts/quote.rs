//! The quote reads of a fact surface (src/core/engine-sql/facts-trust.ts): `listFactsFromQuotedPages`
//! and `listOwnerTierFacts`. search/transcript-quote.ts fences the facts these name before a model
//! reads them.
//!
//! The store keeps no `derivation_inputs`, so a fact is from a quoted page here only through the
//! page that holds it (`source_markdown_slug`) or the page a backstop fact's `source_session`
//! names. Either page may be soft-deleted: the SQL reads every `pages` row.

use super::{FactRecord, read_fact};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::read_page;
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

/// The slug a backstop fact's `source_session` names, when its source is one of `backstop`'s.
fn backstop_slug<'a>(row: &'a FactRecord, backstop: &[(String, String)]) -> Option<&'a str> {
    let session = row.source_session.as_deref()?;
    backstop
        .iter()
        .find(|(source, _)| *source == row.source)
        .and_then(|(_, prefix)| session.strip_prefix(prefix.as_str()))
}

impl Store {
    /// `listFactsFromQuotedPages`: the ids of `ids` whose holding page, or the page a backstop
    /// session names, has a type in `pageTypes`; ascending.
    pub fn list_facts_from_quoted_pages(&self, q: &QuotedPagesQuery) -> Result<Vec<u64>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for row in fact_rows(&*read, &q.ids)? {
            let held = match row.source_markdown_slug.as_deref() {
                Some(slug) => page_of_type(&*read, &row.source_id, slug, &q.page_types)?,
                None => false,
            };
            let named = match backstop_slug(&row, &q.backstop) {
                Some(slug) if !held => page_of_type(&*read, &row.source_id, slug, &q.page_types)?,
                _ => false,
            };
            if held || named {
                out.push(row.id);
            }
        }
        Ok(out)
    }

    /// `listOwnerTierFacts`: the ids of `ids` whose stored tier ranks at or above `floor`;
    /// ascending. A floor that names no tier matches nothing (the SQL compares with NULL).
    pub fn list_owner_tier_facts(&self, q: &OwnerTierQuery) -> Result<Vec<u64>> {
        let Some(floor) = TrustTier::parse(&q.floor) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(fact_rows(&*read, &q.ids)?
            .into_iter()
            .filter(|row| row.tier().rank() >= floor.rank())
            .map(|row| row.id)
            .collect())
    }
}
