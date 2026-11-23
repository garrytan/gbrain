//! Typed reads of stamped trust tiers (src/core/engine-sql/trust-tier-reads.ts): the reads core
//! memory, the trust scan and page history made through `executeRaw`.
//!
//! - [`Store::list_core_page_rows`]: the live `always_load` pages core memory lists, with the trust
//!   columns its delivery reads.
//! - [`Store::list_trust_scan_rows`] / [`Store::count_unscanned_trust_rows`]: the page and fact
//!   rows at a listed stored tier above a cursor.
//! - [`Store::list_version_trust_tiers`] / [`Store::list_version_reason_writers`]: the snapshot
//!   tier of a version, and the type and tier of the write that replaced it.
//! - [`Store::list_page_refs_by_ids`]: the source, slug and type of each listed page, for the
//!   reads that quote a third-party page's rows.
//!
//! They read the tier and write origin fields of the page, fact and version records
//! (`trust::stamp`); no read needs a key range of its own, so the family adds no key prefix.
//!
//! The TypeScript members (src/core/rust-engine/store-members/trust-tier-reads.ts) refuse what the
//! store does not model: a caller page policy that is not the no-caller one, the takes and
//! timeline tables, and a cursor, limit or id that is not an integer. The belief history reads are
//! not served; the valid-time reads live in `trust/valid_time.rs`.

use super::{TrustPolicy, TrustTier, activation_suppressed, withdrawals};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::facts::trust_reads::all_fact_rows;
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::keys;
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::page_body::segmented_reference;
use crate::pages::{PageRecord, VersionRecord, all_pages, read_page_by_id};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `listCorePageRows(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorePageRowQuery {
    /// Restrict to these sources; null is every source.
    pub source_ids: Option<Vec<String>>,
    /// Leave out this one page.
    pub exclude: Option<PageRef>,
    /// `excludePrivate`: the page policy over `p` (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
    /// The caller passed a read eligibility: quarantined pages and pages below the floor drop out,
    /// and the trust columns come back.
    pub eligible: bool,
    /// `eligibility.floor`; null or empty sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: mark (not drop) a page `activationSuppressedSql` flags.
    pub suppress_flagged: bool,
    pub limit: u64,
}

/// One page, by source and slug.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRef {
    pub source_id: String,
    pub slug: String,
}

/// `listTrustScanRows(spec)` and `countUnscannedTrustRows(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustScanQuery {
    /// `pages` or `facts`.
    pub table: String,
    /// Rows with an id above this one.
    pub after_id: i64,
    /// `listTrustScanRows`: at most this many rows.
    #[serde(default)]
    pub limit: Option<u64>,
    /// `countUnscannedTrustRows`: rows with an id at or below this one; null counts every row.
    #[serde(default)]
    pub until: Option<i64>,
    /// The stored tiers the scan reads (`trust_tier = ANY(tiers)`).
    pub tiers: Vec<String>,
}

/// `listVersionTrustTiers(ids)` and `listVersionReasonWriters(ids)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionIdsQuery {
    pub ids: Vec<i64>,
}

/// `listPageRefsByIds(ids)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageIdsQuery {
    pub ids: Vec<i64>,
}

/// The scan's table: `pages` or `facts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanTable {
    Pages,
    Facts,
}

fn scan_table(op: &str, table: &str) -> Result<ScanTable> {
    match table {
        "pages" => Ok(ScanTable::Pages),
        "facts" => Ok(ScanTable::Facts),
        other => Err(StoreError::invalid(format!(
            "{op}: the store scans pages and facts, not \"{other}\""
        ))),
    }
}

fn check_tiers(op: &str, tiers: &[String]) -> Result<()> {
    for tier in tiers {
        no_nul(op, &[("tiers", tier)])?;
    }
    Ok(())
}

/// The stored tier name of a page (`None` reads as `unknown`).
fn page_tier(page: &PageRecord) -> TrustTier {
    TrustTier::stored(page.trust_tier.as_deref())
}

/// `frontmatter @> '{"always_load": true}'`.
fn always_load(frontmatter: &Map<String, Value>) -> bool {
    frontmatter.get("always_load") == Some(&Value::Bool(true))
}

/// The version records whose id is listed (a negative id names no row), by id.
fn listed_versions(read: &dyn crate::kv::KvRead, ids: &[i64]) -> Result<Vec<VersionRecord>> {
    let wanted: BTreeSet<u64> = ids
        .iter()
        .filter_map(|&id| u64::try_from(id).ok())
        .collect();
    let mut out: Vec<VersionRecord> = all_versions(read)?
        .into_iter()
        .filter(|v| wanted.contains(&v.id))
        .collect();
    out.sort_by_key(|v| v.id);
    Ok(out)
}

/// Every version record (`V page_id id` keys).
fn all_versions(read: &dyn crate::kv::KvRead) -> Result<Vec<VersionRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::VERSION], false, &mut |_, v| {
        match serde_json::from_slice::<VersionRecord>(v) {
            Ok(row) => out.push(row),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

impl Store {
    /// `listCorePageRows`: the live pages whose frontmatter sets `always_load: true`, under the
    /// source and exclude filters and, with `excludePrivate`, the page policy; with `eligible`, less
    /// the quarantined pages (`quarantine` key) and the pages below the floor, each with its stored
    /// tier, write origin and `suppressed` mark. Each row carries `withdrawn`: a withdrawal of its
    /// source with subject `*` or its slug. By source then slug (byte order), at most `limit`.
    pub fn list_core_page_rows(&self, q: &CorePageRowQuery) -> Result<Vec<Value>> {
        const OP: &str = "listCorePageRows";
        for source in q.source_ids.iter().flatten() {
            no_nul(OP, &[("sourceIds", source)])?;
        }
        if let Some(e) = &q.exclude {
            no_nul(
                OP,
                &[
                    ("exclude.sourceId", &e.source_id),
                    ("exclude.slug", &e.slug),
                ],
            )?;
        }
        let floor = TrustPolicy::parse(q.min_trust.as_deref(), false)?;
        let read = self.read()?;
        let sources: Option<BTreeSet<&str>> = q
            .source_ids
            .as_ref()
            .map(|ids| ids.iter().map(String::as_str).collect());
        let mut pages: Vec<PageRecord> = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !always_load(&page.frontmatter) {
                continue;
            }
            if sources
                .as_ref()
                .is_some_and(|s| !s.contains(page.source_id.as_str()))
            {
                continue;
            }
            if q.exclude
                .as_ref()
                .is_some_and(|e| e.source_id == page.source_id && e.slug == page.slug)
            {
                continue;
            }
            if let Some(policy) = &q.exclude_private
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            if q.eligible
                && (page.frontmatter.contains_key("quarantine")
                    || !floor.admits(&*read, "pages", page.id, page_tier(&page))?)
            {
                continue;
            }
            pages.push(page);
        }
        pages.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        let limit = usize::try_from(q.limit).unwrap_or(usize::MAX);
        let mut out = Vec::new();
        for page in pages.into_iter().take(limit) {
            let segmented = segmented_reference(&*read, page.id)?;
            let mut row = json!({
                "id": page.id,
                "source_id": page.source_id,
                "slug": page.slug,
                "title": page.title,
                "compiled_truth": page.compiled_truth.as_deref(),
                "frontmatter": page.frontmatter,
                "segmented": segmented.is_some(),
                "body_bytes": segmented.and_then(|(_, bytes)| bytes),
                "withdrawn": withdrawals::covers_page(&*read, &page.source_id, &page.slug)?,
            });
            if q.eligible {
                let tier = page_tier(&page);
                row["trust_tier"] = json!(tier.as_str());
                row["write_origin"] = page.write_origin.clone().unwrap_or(Value::Null);
                row["suppressed"] = json!(
                    q.suppress_flagged && activation_suppressed(&*read, "pages", page.id, tier)?
                );
            }
            out.push(row);
        }
        Ok(out)
    }

    /// `listTrustScanRows`: the live pages (or the facts) with an id above `afterId` whose stored
    /// tier is listed, by id, at most `limit`: the id, source, tier and write origin, then the
    /// table's content columns.
    pub fn list_trust_scan_rows(&self, q: &TrustScanQuery) -> Result<Vec<Value>> {
        const OP: &str = "listTrustScanRows";
        let table = scan_table(OP, &q.table)?;
        check_tiers(OP, &q.tiers)?;
        let limit = q
            .limit
            .ok_or_else(|| StoreError::invalid(format!("{OP}: limit is required")))?;
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let read = self.read()?;
        let mut rows = self.scan_rows(&*read, table, q)?;
        rows.truncate(limit);
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    }

    /// `countUnscannedTrustRows`: how many rows `listTrustScanRows` would read above `afterId`, at
    /// or below `until` when it is set.
    pub fn count_unscanned_trust_rows(&self, q: &TrustScanQuery) -> Result<u64> {
        const OP: &str = "countUnscannedTrustRows";
        let table = scan_table(OP, &q.table)?;
        check_tiers(OP, &q.tiers)?;
        let read = self.read()?;
        let rows = self.scan_rows(&*read, table, q)?;
        Ok(rows
            .iter()
            .filter(|(id, _)| {
                q.until
                    .is_none_or(|until| i128::from(*id) <= i128::from(until))
            })
            .count() as u64)
    }

    /// The scanned rows of `table` above `q.after_id` at a listed tier, by id, each with its id.
    fn scan_rows(
        &self,
        read: &dyn crate::kv::KvRead,
        table: ScanTable,
        q: &TrustScanQuery,
    ) -> Result<Vec<(u64, Value)>> {
        let tiers: BTreeSet<&str> = q.tiers.iter().map(String::as_str).collect();
        let above = |id: u64| i128::from(id) > i128::from(q.after_id);
        let mut out = Vec::new();
        match table {
            ScanTable::Pages => {
                for page in all_pages(read)? {
                    let tier = page_tier(&page);
                    if page.deleted_at_us.is_some()
                        || !above(page.id)
                        || !tiers.contains(tier.as_str())
                    {
                        continue;
                    }
                    out.push((
                        page.id,
                        json!({
                            "id": page.id,
                            "source_id": page.source_id,
                            "trust_tier": tier.as_str(),
                            "write_origin": page.write_origin,
                            "title": page.title,
                            "compiled_truth": page.compiled_truth.as_deref(),
                            "timeline": page.timeline.as_deref(),
                            "frontmatter": page.frontmatter,
                        }),
                    ));
                }
            }
            ScanTable::Facts => {
                for fact in all_fact_rows(read)? {
                    let tier = fact.tier();
                    if !above(fact.id) || !tiers.contains(tier.as_str()) {
                        continue;
                    }
                    out.push((
                        fact.id,
                        json!({
                            "id": fact.id,
                            "source_id": fact.source_id,
                            "trust_tier": tier.as_str(),
                            "write_origin": fact.write_origin,
                            "fact": fact.fact,
                            "context": fact.context,
                            "value": fact.value,
                            "source": fact.source,
                        }),
                    ));
                }
            }
        }
        out.sort_by_key(|(id, _)| *id);
        Ok(out)
    }

    /// `listVersionTrustTiers`: the stored snapshot tier of each listed version, by id. An id no
    /// version has answers nothing.
    pub fn list_version_trust_tiers(&self, q: &VersionIdsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(listed_versions(&*read, &q.ids)?
            .into_iter()
            .map(|v| json!({ "id": v.id, "trust_tier": TrustTier::stored(v.trust_tier.as_deref()).as_str() }))
            .collect())
    }

    /// `listVersionReasonWriters`: for each listed version whose page row exists (deleted or
    /// not), the type and stored tier of the page's next snapshot (the smallest later id), or of
    /// the page itself when there is none. By id.
    pub fn list_version_reason_writers(&self, q: &VersionIdsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let listed = listed_versions(&*read, &q.ids)?;
        if listed.is_empty() {
            return Ok(Vec::new());
        }
        let mut by_page: BTreeMap<u64, BTreeMap<u64, VersionRecord>> = BTreeMap::new();
        for v in all_versions(&*read)? {
            by_page.entry(v.page_id).or_default().insert(v.id, v);
        }
        let mut out = Vec::new();
        for v in listed {
            let Some(page) = read_page_by_id(&*read, v.page_id)? else {
                continue;
            };
            let next = by_page
                .get(&v.page_id)
                .and_then(|versions| versions.range(v.id + 1..).next().map(|(_, n)| n));
            let (kind, tier) = match next {
                Some(n) => (
                    n.page_type.clone(),
                    TrustTier::stored(n.trust_tier.as_deref()),
                ),
                None => (page.page_type.clone(), page_tier(&page)),
            };
            out.push(json!({ "id": v.id, "type": kind, "tier": tier.as_str() }));
        }
        Ok(out)
    }

    /// `listPageRefsByIds`: the source, slug and stored type of each listed page record, deleted
    /// or not, by id, once each. An id no page has (a purged page, a negative id) answers nothing.
    pub fn list_page_refs_by_ids(&self, q: &PageIdsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<u64> = q
            .ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in wanted {
            if let Some(page) = read_page_by_id(&*read, id)? {
                out.push(json!({
                    "id": page.id,
                    "source_id": page.source_id,
                    "slug": page.slug,
                    "type": page.page_type,
                }));
            }
        }
        Ok(out)
    }
}
