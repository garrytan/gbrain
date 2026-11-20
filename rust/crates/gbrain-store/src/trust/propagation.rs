//! The derived-tier propagation members of src/core/engine-sql/derivation-trust.ts:
//! `lowerDerivedDependents` (one hop of trust/propagation.ts), `readTierProjectionPage` and
//! `locateRetierSubjects`, plus the tiered-row reads and writes `lowerTrustTier`
//! (`trust::derivation`) shares.
//!
//! A hop reads each derived row's recorded inputs from the `derivation_inputs` edges
//! (`generations::derivation_inputs`), takes the least trusted input that still exists (a
//! soft-deleted page counts, as the SQL joins read it), and lowers the row to that tier when the
//! row ranks above it. A Rust brain is never managed, so no row is marked `needs_rederive` instead.

use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::transaction_clock;
use crate::error::{Result, StoreError};
use crate::facts::FactRecord;
use crate::generations::derivation_inputs::inputs_of;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page_by_id, write_page_setting_trust};
use crate::takes::TakeRecord;
use crate::timeline::TimelineRecord;
use crate::trust::{TrustTable, TrustTier, WriteTrust, set_row_trust};
use crate::{Store, keys, put_json};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `lowerDerivedDependents(spec)`: `ids` are derived row ids as the edges record them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LowerDependentsSpec {
    pub table: String,
    pub ids: Vec<String>,
    pub managed: bool,
}

/// `readTierProjectionPage(spec)`: `table` is `facts`, `takes` or `pages`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TierProjectionQuery {
    pub table: String,
    pub id: i64,
}

/// `locateRetierSubjects(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetierSubjectsQuery {
    pub facts: Vec<i64>,
    pub takes: Vec<i64>,
    pub pages: Vec<i64>,
}

/// A stored row of a tiered table.
pub(crate) enum TieredRow {
    Page(PageRecord),
    Fact(FactRecord),
    Take(TakeRecord),
    Timeline(TimelineRecord),
}

impl TieredRow {
    pub(crate) fn tier(&self) -> TrustTier {
        match self {
            TieredRow::Page(p) => TrustTier::stored(p.trust_tier.as_deref()),
            TieredRow::Fact(f) => f.tier(),
            TieredRow::Take(t) => t.trust.tier(),
            TieredRow::Timeline(e) => e.trust.tier(),
        }
    }

    fn origin(&self) -> Option<&Value> {
        match self {
            TieredRow::Page(p) => p.write_origin.as_ref(),
            TieredRow::Fact(f) => f.write_origin.as_ref(),
            TieredRow::Take(t) => t.trust.write_origin.as_ref(),
            TieredRow::Timeline(e) => e.trust.write_origin.as_ref(),
        }
    }
}

/// A tiered table's name, or an `invalid` error naming `op`.
pub(crate) fn tiered_table(op: &str, name: &str) -> Result<TrustTable> {
    match name {
        "facts" => Ok(TrustTable::Facts),
        "takes" => Ok(TrustTable::Takes),
        "timeline_entries" => Ok(TrustTable::TimelineEntries),
        "pages" => Ok(TrustTable::Pages),
        other => Err(StoreError::invalid(format!(
            "{op}: unknown table \"{other}\""
        ))),
    }
}

/// The stored rows of `table` among `ids`, by id; a page is read deleted or not. Timeline rows
/// are keyed by page and date, so they are found by one scan.
pub(crate) fn read_tiered(
    read: &dyn KvRead,
    table: TrustTable,
    ids: &BTreeSet<u64>,
) -> Result<BTreeMap<u64, TieredRow>> {
    let mut out = BTreeMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    if table == TrustTable::TimelineEntries {
        let mut failure = None;
        scan_prefix(read, &[keys::TIMELINE], false, &mut |_, v| {
            match serde_json::from_slice::<TimelineRecord>(v) {
                Ok(r) if ids.contains(&r.id) => {
                    out.insert(r.id, TieredRow::Timeline(r));
                }
                Ok(_) => {}
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        return failure.map_or(Ok(out), Err);
    }
    for &id in ids {
        let row = match table {
            TrustTable::Pages => read_page_by_id(read, id)?.map(TieredRow::Page),
            TrustTable::Facts => crate::facts::read_fact(read, id)?.map(TieredRow::Fact),
            TrustTable::Takes => crate::takes::read_take(read, id)?.map(TieredRow::Take),
            TrustTable::TimelineEntries => unreachable!("timeline rows are scanned above"),
        };
        if let Some(row) = row {
            out.insert(id, row);
        }
    }
    Ok(out)
}

/// Stores `row` with `tier` and `origin`, as an `UPDATE` that sets both columns and no content
/// column: a page keeps its knowledge revision, and a fact, take or timeline row keeps every other
/// column, its write receipt included. The stamp (`trust::stamp`) runs as PGLite's
/// `trust_tier_stamp` trigger runs for such an update.
pub(crate) fn write_tiered(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    row: TieredRow,
    tier: TrustTier,
    origin: Option<Value>,
) -> Result<()> {
    match row {
        TieredRow::Page(page) => write_page_setting_trust(tx, &page, Some((tier, origin))),
        TieredRow::Fact(old) => {
            let mut new = old.clone();
            new.trust_tier = tier.as_str().to_owned();
            new.write_origin = origin;
            crate::facts::write_fact(tx, trust, Some(&old), &new)
        }
        TieredRow::Take(mut take) => {
            take.trust = set_row_trust(TrustTable::Takes, &take.trust, tier, origin)?;
            crate::takes::write_take(tx, &take)
        }
        TieredRow::Timeline(mut entry) => {
            entry.trust = set_row_trust(TrustTable::TimelineEntries, &entry.trust, tier, origin)?;
            put_json(
                tx,
                &keys::timeline(entry.page_id, &entry.date, entry.id),
                &entry,
            )
        }
    }
}

/// `^[0-9]+$` read as a row id, as the SQL `numericId` cast reads it.
fn numeric_id(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// PostgreSQL's `COALESCE(old, '{}') || {"input_lowered": lowered}`: an object gains or replaces
/// the key, an array gains the object as its last element, and a scalar becomes `[scalar, object]`.
fn with_input_lowered(old: Option<&Value>, lowered: Value) -> Value {
    match old {
        None => json!({ "input_lowered": lowered }),
        Some(Value::Object(map)) => {
            let mut map = map.clone();
            map.insert("input_lowered".into(), lowered);
            Value::Object(map)
        }
        Some(Value::Array(items)) => {
            let mut items = items.clone();
            items.push(json!({ "input_lowered": lowered }));
            Value::Array(items)
        }
        Some(scalar) => json!([scalar, { "input_lowered": lowered }]),
    }
}

/// The least trusted rank among the recorded inputs of each derived row in `ids`, for the rows
/// with at least one input that exists.
fn least_input_rank(read: &dyn KvRead, table: &str, ids: &[String]) -> Result<BTreeMap<u64, u8>> {
    let mut edges: Vec<(u64, TrustTable, u64)> = Vec::new();
    let mut wanted: BTreeMap<TrustTable, BTreeSet<u64>> = BTreeMap::new();
    let distinct: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    for text in distinct {
        let Some(derived) = numeric_id(text) else {
            continue;
        };
        for (input_table, input_id) in inputs_of(read, table, text)? {
            let (Ok(input_table), Some(input_id)) =
                (tiered_table("", &input_table), numeric_id(&input_id))
            else {
                continue;
            };
            wanted.entry(input_table).or_default().insert(input_id);
            edges.push((derived, input_table, input_id));
        }
    }
    let mut ranks: BTreeMap<(TrustTable, u64), u8> = BTreeMap::new();
    for (input_table, input_ids) in &wanted {
        for (id, row) in read_tiered(read, *input_table, input_ids)? {
            ranks.insert((*input_table, id), row.tier().rank());
        }
    }
    let mut least: BTreeMap<u64, u8> = BTreeMap::new();
    for (derived, input_table, input_id) in edges {
        if let Some(&rank) = ranks.get(&(input_table, input_id)) {
            least
                .entry(derived)
                .and_modify(|r| *r = (*r).min(rank))
                .or_insert(rank);
        }
    }
    Ok(least)
}

fn tier_of_rank(rank: u8) -> TrustTier {
    TrustTier::ALL
        .into_iter()
        .find(|t| t.rank() == rank)
        .unwrap_or(TrustTier::Unknown)
}

fn positive(ids: &[i64]) -> BTreeSet<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

impl Store {
    /// `lowerDerivedDependents(table, ids, managed)`: lowers each `table` row among `ids` whose
    /// least trusted recorded input ranks below it to that input's tier, merging
    /// `{"input_lowered": {"from": <its tier>, "at": now()::text}}` into its write origin, and
    /// resolves `{ id, from_tier, to_tier }` for each row lowered, in id order. Every row is
    /// read before any is written, as the SQL selects its candidates before its UPDATE. A
    /// managed brain is refused: a Rust brain never is one.
    pub fn lower_derived_dependents(&self, spec: &LowerDependentsSpec) -> Result<Vec<Value>> {
        let op = "lowerDerivedDependents";
        let table = tiered_table(op, &spec.table)?;
        if spec.managed {
            return Err(StoreError::invalid(format!(
                "{op}: a Rust brain is never managed"
            )));
        }
        if spec.ids.is_empty() {
            return Ok(Vec::new());
        }
        let trust = self.write_trust()?;
        self.write(|tx| {
            let least = least_input_rank(&*tx, &spec.table, &spec.ids)?;
            let derived = read_tiered(&*tx, table, &least.keys().copied().collect())?;
            let now = transaction_clock::transaction_now().ok_or_else(|| {
                StoreError::invalid("lowerDerivedDependents ran outside a store write transaction")
            })?;
            let at = timestamptz_text(now);
            let mut lowered = Vec::new();
            for (id, row) in derived {
                let from = row.tier();
                let rank = least[&id];
                if rank >= from.rank() {
                    continue;
                }
                let to = tier_of_rank(rank);
                let origin =
                    with_input_lowered(row.origin(), json!({ "from": from.as_str(), "at": at }));
                write_tiered(tx, &trust, row, to, Some(origin))?;
                lowered
                    .push(json!({ "id": id, "from_tier": from.as_str(), "to_tier": to.as_str() }));
            }
            Ok(lowered)
        })
    }

    /// `readTierProjectionPage(table, id)`: `{ source_id, slug }` of a fact's provenance page
    /// (none without one), a take's page or the page itself; deleted pages count, as the SQL
    /// join reads them.
    pub fn read_tier_projection_page(&self, q: &TierProjectionQuery) -> Result<Option<Value>> {
        let read = self.read()?;
        let Ok(id) = u64::try_from(q.id) else {
            return Ok(None);
        };
        let page = |page: Option<PageRecord>| {
            page.map(|p| json!({ "source_id": p.source_id, "slug": p.slug }))
        };
        Ok(match q.table.as_str() {
            "facts" => crate::facts::read_fact(&*read, id)?.and_then(|f| {
                f.source_markdown_slug
                    .map(|slug| json!({ "source_id": f.source_id, "slug": slug }))
            }),
            "takes" => match crate::takes::read_take(&*read, id)? {
                Some(take) => page(read_page_by_id(&*read, take.page_id)?),
                None => None,
            },
            "pages" => page(read_page_by_id(&*read, id)?),
            other => {
                return Err(StoreError::invalid(format!(
                    "readTierProjectionPage: unknown table \"{other}\""
                )));
            }
        })
    }

    /// `locateRetierSubjects({ facts, takes, pages })`: `{ t, id, source_id, slug }` for each
    /// listed row that exists. A fact's slug is its provenance page, else its entity; a take's
    /// is its page's.
    pub fn locate_retier_subjects(&self, q: &RetierSubjectsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in positive(&q.facts) {
            if let Some(f) = crate::facts::read_fact(&*read, id)? {
                let slug = f.source_markdown_slug.or(f.entity_slug);
                out.push(json!({ "t": "facts", "id": id, "source_id": f.source_id, "slug": slug }));
            }
        }
        for id in positive(&q.takes) {
            if let Some(take) = crate::takes::read_take(&*read, id)?
                && let Some(p) = read_page_by_id(&*read, take.page_id)?
            {
                out.push(
                    json!({ "t": "takes", "id": id, "source_id": p.source_id, "slug": p.slug }),
                );
            }
        }
        for id in positive(&q.pages) {
            if let Some(p) = read_page_by_id(&*read, id)? {
                out.push(
                    json!({ "t": "pages", "id": id, "source_id": p.source_id, "slug": p.slug }),
                );
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_merged_origin_follows_jsonb_concatenation() {
        let lowered = json!({ "from": "operator_curated", "at": "t" });
        assert_eq!(
            with_input_lowered(None, lowered.clone()),
            json!({ "input_lowered": lowered })
        );
        assert_eq!(
            with_input_lowered(
                Some(&json!({ "a": 1, "input_lowered": 0 })),
                lowered.clone()
            ),
            json!({ "a": 1, "input_lowered": lowered })
        );
        assert_eq!(
            with_input_lowered(Some(&json!([1])), lowered.clone()),
            json!([1, { "input_lowered": lowered }])
        );
        assert_eq!(
            with_input_lowered(Some(&json!("s")), lowered.clone()),
            json!(["s", { "input_lowered": lowered }])
        );
    }

    #[test]
    fn only_digit_text_reads_as_a_row_id() {
        assert_eq!(numeric_id("42"), Some(42));
        for text in ["", "-1", "4a", " 4", "99999999999999999999999"] {
            assert_eq!(numeric_id(text), None, "{text:?}");
        }
        assert_eq!(tier_of_rank(1), TrustTier::ExternalUntrusted);
        assert_eq!(tier_of_rank(6), TrustTier::UserConfirmed);
    }

    #[test]
    fn a_managed_hop_is_refused() {
        let store = crate::test_support::store();
        let spec = LowerDependentsSpec {
            table: "pages".into(),
            ids: vec!["1".into()],
            managed: true,
        };
        assert!(store.lower_derived_dependents(&spec).is_err());
        let unknown = LowerDependentsSpec {
            table: "links".into(),
            ids: vec![],
            managed: false,
        };
        assert!(store.lower_derived_dependents(&unknown).is_err());
    }
}
