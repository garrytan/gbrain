//! The three page-shape reads of `gbrain schema detect` (`engine-sql/schema-detect.ts`): `pageTypeTotals`,
//! `pagePrefixSamples` and `countPagesByTypeForSource`.
//!
//! Each reads the live pages (`deleted_at` unset) of one source. A page's type is never null (`pages.type` is NOT
//! NULL), so an untyped page has the empty type. A prefix is the slug up to and including its first `/` when at least
//! one character comes before it (`substring(slug from '^[^/]+/')`); a slug that starts with `/` has the null prefix,
//! and a slug with no `/` is not counted. Counts sort largest first; a tie sorts by the prefix or type in byte order
//! (`COLLATE "C"`, the null prefix last), and the types under a prefix are distinct and in byte order. See
//! rust/docs/store/schema_detect.md.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::Store;
use crate::error::Result;
use crate::pages::{PageRecord, all_pages};

/// `pageTypeTotals` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageTypeTotalsArgs {
    pub source_id: String,
}

/// `pagePrefixSamples` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PagePrefixSamplesArgs {
    pub source_id: String,
    pub min_pages: i64,
    pub limit: u64,
}

/// `countPagesByTypeForSource` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageTypeCountsArgs {
    pub source_id: String,
    pub limit: u64,
}

/// The slug's prefix: up to and including the first `/`, or `None` when the slug starts with `/`.
fn slug_prefix(slug: &str) -> Option<&str> {
    match slug.find('/') {
        Some(0) | None => None,
        Some(at) => Some(&slug[..=at]),
    }
}

fn take(limit: u64) -> usize {
    usize::try_from(limit).unwrap_or(usize::MAX)
}

impl Store {
    fn live_source_pages(&self, source_id: &str) -> Result<Vec<PageRecord>> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.source_id == source_id)
            .collect())
    }

    /// `pageTypeTotals`: `{ total, typed, untyped }`.
    pub fn page_type_totals(&self, a: &PageTypeTotalsArgs) -> Result<Value> {
        let pages = self.live_source_pages(&a.source_id)?;
        let untyped = pages.iter().filter(|p| p.page_type.is_empty()).count();
        Ok(json!({ "total": pages.len(), "typed": pages.len() - untyped, "untyped": untyped }))
    }

    /// `pagePrefixSamples`: `[{ prefix, cnt, sample_types }]`, prefixes with at least `minPages` pages, at most
    /// `limit`.
    pub fn page_prefix_samples(&self, a: &PagePrefixSamplesArgs) -> Result<Value> {
        let pages = self.live_source_pages(&a.source_id)?;
        let mut groups: BTreeMap<Option<&str>, (i64, BTreeSet<&str>)> = BTreeMap::new();
        for page in pages.iter().filter(|p| p.slug.contains('/')) {
            let group = groups.entry(slug_prefix(&page.slug)).or_default();
            group.0 += 1;
            if !page.page_type.is_empty() {
                group.1.insert(&page.page_type);
            }
        }
        let mut rows: Vec<(Option<&str>, i64, BTreeSet<&str>)> = groups
            .into_iter()
            .filter(|(_, (cnt, _))| *cnt >= a.min_pages)
            .map(|(prefix, (cnt, types))| (prefix, cnt, types))
            .collect();
        rows.sort_by(|x, y| {
            y.1.cmp(&x.1)
                .then_with(|| (x.0.is_none(), x.0).cmp(&(y.0.is_none(), y.0)))
        });
        Ok(Value::Array(
            rows.into_iter()
                .take(take(a.limit))
                .map(|(prefix, cnt, types)| json!({ "prefix": prefix, "cnt": cnt, "sample_types": types }))
                .collect(),
        ))
    }

    /// `countPagesByTypeForSource`: `[{ type, cnt }]` of the typed pages, at most `limit`.
    pub fn count_pages_by_type_for_source(&self, a: &PageTypeCountsArgs) -> Result<Value> {
        let pages = self.live_source_pages(&a.source_id)?;
        let mut counts: BTreeMap<&str, i64> = BTreeMap::new();
        for page in pages.iter().filter(|p| !p.page_type.is_empty()) {
            *counts.entry(&page.page_type).or_default() += 1;
        }
        let mut rows: Vec<(&str, i64)> = counts.into_iter().collect();
        rows.sort_by(|x, y| y.1.cmp(&x.1).then_with(|| x.0.cmp(y.0)));
        Ok(Value::Array(
            rows.into_iter()
                .take(take(a.limit))
                .map(|(t, cnt)| json!({ "type": t, "cnt": cnt }))
                .collect(),
        ))
    }
}
