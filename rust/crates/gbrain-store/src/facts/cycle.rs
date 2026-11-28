//! Group 5 facts reads, command, cycle and fence reads (src/core/engine-sql/facts-cycle.ts): the statements the
//! enrich, extract-conversation-facts, v0.32.2 migration, purge, extract_facts, consolidate, bulk-day, fence-append,
//! fence-repair and entity-card paths ran through `executeRaw`.
//!
//! Members: listActiveFactsForEntity, listFreshExtractionOutcomes, listFenceRowGroups, readFactSubject,
//! listFactProvenance, factsOrAliasesMayMatch, readFactForForget, listFactsForPage, countLegacyFactsPending, countUnconsolidatedFactsBySource, findBulkFactDays, maxFenceRowNum,
//! listStoredFenceFactRows, countWorldFacts.
//!
//! Each member reads the rows its statement reads, through the indexes `facts.rs` keeps, and returns the columns the
//! statement selects. A statement with no `ORDER BY` returns its rows in key order here (the TypeScript callers do
//! not depend on an order). Each fact row keeps its stamped `trust_tier`, and the write gate keeps its receipts
//! (`trust/write_gate.rs`), so `countWorldFacts` applies the read eligibility (`trust::TrustPolicy`) and hides a row a
//! purge marked in `needs_rederive` (`generations/needs_rederive.rs`). The facts store keeps no `page_readers` column
//! (`privacy.rs`): a page names readers here only through a `readable_by` key, and sits under a folder through the store's folder rules. rust/docs/store/facts.md, "Group 5", lists what each member answers.

use super::repair::folder_restricted;
use super::{
    FactRecord, PrivacyPolicy, ROW, any_entity_slug, bigint, count_arg, fact_by_number,
    hidden_by_deleted_page, hidden_by_policy, hidden_by_quarantine, page_rows, real,
};
use crate::Store;
use crate::alias_fanout_reads::alias_row_exists;
use crate::env::iso;
use crate::error::Result;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page;
use crate::sources::{all_sources, read_source};
use crate::trust::TrustPolicy;
use crate::{StoreError, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The slugs of a `= ANY($n::text[])` list, each once.
fn distinct<'a>(op: &str, what: &str, list: &'a [String]) -> Result<BTreeSet<&'a str>> {
    let set: BTreeSet<&str> = list.iter().map(String::as_str).collect();
    for item in &set {
        no_nul(op, &[(what, item)])?;
    }
    Ok(set)
}

/// Every fact row that `keep` admits, in id order (a scan of the `F 0x01` primary keys).
fn scan_rows(
    read: &dyn KvRead,
    keep: &mut dyn FnMut(&FactRecord) -> bool,
) -> Result<Vec<FactRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::FACT, ROW], false, &mut |_, v| {
        match serde_json::from_slice::<FactRecord>(v) {
            Ok(row) => {
                if keep(&row) {
                    out.push(row);
                }
            }
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// `listActiveFactsForEntity` arguments.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityFactsQuery {
    pub source_id: String,
    pub entity_slug: String,
    pub limit: f64,
}

/// `listFreshExtractionOutcomes` arguments.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractionOutcomeQuery {
    pub source_id: String,
    pub slugs: Vec<String>,
    pub sources: Vec<String>,
    pub preferred_source: String,
}

/// `listFactsForPage`, `maxFenceRowNum` and `listStoredFenceFactRows` arguments: one page coordinate.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageCoordinate {
    pub source_id: String,
    pub slug: String,
}

/// `readPageFileOrigin` arguments: a page coordinate, and whether a soft-deleted page still answers.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageFileOriginQuery {
    pub source_id: String,
    pub slug: String,
    pub include_deleted: bool,
}

/// `factsOrAliasesMayMatch` arguments: a source, slug tokens and normalised aliases.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MayMatchQuery {
    pub source_id: String,
    pub slug_tokens: Vec<String>,
    pub alias_norms: Vec<String>,
}

/// `entity_slug ~ '(^|/)token(-|$)'`: `token` starts the slug or follows a `/`, and ends it or is followed by a `-`.
/// A token is slugify output, so it holds no regex metacharacter.
fn slug_segment_match(slug: &str, token: &str) -> bool {
    slug.match_indices(token).any(|(i, _)| {
        let before = i == 0 || slug.as_bytes()[i - 1] == b'/';
        let after = slug.as_bytes().get(i + token.len());
        before && after.is_none_or(|b| *b == b'-')
    })
}

/// `readFenceRowOccupant` arguments: a page coordinate and a row number.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FenceRowOccupantQuery {
    pub source_id: String,
    pub slug: String,
    pub row_num: i64,
}

/// `countUnconsolidatedFactsBySource` arguments.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BucketQuery {
    /// `$1`: one source, or every source.
    pub source_id: Option<String>,
    /// `$2`: a managed brain keeps world facts only.
    pub world_only: bool,
    /// `$3`: the least facts of a bucket.
    pub min_per_bucket: f64,
}

/// The #7247 bulk-day thresholds (`BULK_DAY_RULE`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkDayRule {
    pub min_facts: f64,
    pub min_share: f64,
    pub min_entities: f64,
}

/// `findBulkFactDays` arguments.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkDayQuery {
    /// `$1`: `None` for every unarchived source.
    pub source_ids: Option<Vec<String>>,
    pub rule: BulkDayRule,
}

/// `countWorldFacts` arguments.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldFactCount {
    pub source_id: String,
    pub entity_slugs: Vec<String>,
    /// `AND visibility = 'world'`.
    pub world_only: bool,
    /// `privateFactFilterForReader('facts')` (`facts/privacy.rs`), when the card asks for it.
    pub exclude_private: Option<PrivacyPolicy>,
    /// `eligibility.floor`: `trustFloorSql` over the fact's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: drop a fact `activationSuppressedSql('facts')` flags.
    pub suppress_flagged: bool,
}

/// A date token of `fact` starts at `at`: `YYYY-MM-DD` with no digit right after it.
fn date_at(chars: &[char], at: usize) -> bool {
    let shape = b"dddd-dd-dd";
    if at + shape.len() > chars.len() {
        return false;
    }
    let fits = shape
        .iter()
        .zip(&chars[at..])
        .all(|(&want, &c)| match want {
            b'd' => c.is_ascii_digit(),
            _ => c == '-',
        });
    fits && chars
        .get(at + shape.len())
        .is_none_or(|c| !c.is_ascii_digit())
}

/// The matches of `regexp_matches(fact, '(^|[^0-9])([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])', 'g')`, group 2 of each.
/// A match takes its leading character (or the string start), so the next one starts after the date.
fn date_tokens(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i <= chars.len() {
        if i == 0 && date_at(&chars, 0) {
            tokens.push(chars[..10].iter().collect());
            i = 10;
        } else if i < chars.len() && !chars[i].is_ascii_digit() && date_at(&chars, i + 1) {
            tokens.push(chars[i + 1..i + 11].iter().collect());
            i += 11;
        } else {
            i += 1;
        }
    }
    tokens
}

/// `claimDateSql(fact, day)`: the fact's only date token is a real calendar date from 1900-01-01 up to the day before `day`.
fn dated_claim(fact: &str, day: &str) -> bool {
    let tokens = date_tokens(fact);
    let [token] = tokens.as_slice() else {
        return false;
    };
    let number = |range: std::ops::Range<usize>| token[range].parse::<u32>().unwrap_or(0);
    let (year, month, date) = (number(0..4), number(5..7), number(8..10));
    if token.as_str() < "1900-01-01"
        || token.as_str() >= day
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&date)
    {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let length = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    date <= length
}

impl Store {
    /// `listActiveFactsForEntity` (src/commands/enrich.ts): the entity's unexpired rows that have not lapsed, by
    /// `confidence DESC, id DESC`, at most `limit`. Each row is `{ fact, context }`.
    pub fn list_active_facts_for_entity(&self, q: &EntityFactsQuery) -> Result<Vec<Value>> {
        const OP: &str = "listActiveFactsForEntity";
        no_nul(
            OP,
            &[("sourceId", &q.source_id), ("entitySlug", &q.entity_slug)],
        )?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut rows: Vec<FactRecord> = super::entity_rows(&*read, &q.source_id, &q.entity_slug)?
            .into_iter()
            .filter(|r| r.active(now))
            .collect();
        rows.sort_by(|a, b| b.confidence.total_cmp(&a.confidence).then(b.id.cmp(&a.id)));
        Ok(rows
            .iter()
            .take(limit)
            .map(|r| json!({ "fact": r.fact, "context": r.context }))
            .collect())
    }

    /// `listFreshExtractionOutcomes` (src/commands/extract-conversation-facts.ts): the unexpired rows of each of
    /// `slugs` whose `source` is one of `sources`, each `{ slug, source, source_session }`, by slug, the rows of
    /// `preferredSource` first within a slug, then by id.
    pub fn list_fresh_extraction_outcomes(&self, q: &ExtractionOutcomeQuery) -> Result<Vec<Value>> {
        const OP: &str = "listFreshExtractionOutcomes";
        no_nul(
            OP,
            &[
                ("sourceId", &q.source_id),
                ("preferredSource", &q.preferred_source),
            ],
        )?;
        let slugs = distinct(OP, "slugs", &q.slugs)?;
        let wanted = distinct(OP, "sources", &q.sources)?;
        let read = self.read()?;
        let mut out: Vec<(&str, bool, u64, Value)> = Vec::new();
        for slug in slugs {
            for row in page_rows(&*read, &q.source_id, slug)? {
                if row.expired_at_us.is_none() && wanted.contains(row.source.as_str()) {
                    let preferred = row.source != q.preferred_source;
                    out.push((slug, preferred, row.id, json!({
                        "slug": slug, "source": row.source, "source_session": row.source_session,
                    })));
                }
            }
        }
        out.sort_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
        Ok(out.into_iter().map(|r| r.3).collect())
    }

    /// `listFenceRowGroups` (src/commands/migrations/v0_32_2.ts): per `(source_id, source_markdown_slug)` the rows
    /// that hold a `row_num` and are not conversation-miner (`cli:`) rows, each group
    /// `{ source_id, source_markdown_slug, row_nums, all_expired }` with the numbers sorted. By `(source, slug)`.
    pub fn list_fence_row_groups(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let rows = scan_rows(&*read, &mut |r| {
            r.row_num.is_some() && !r.source.starts_with("cli:")
        })?;
        type Group = (Vec<i32>, bool);
        let mut groups: BTreeMap<(&str, Option<&str>), Group> = BTreeMap::new();
        for row in &rows {
            let group = groups
                .entry((&row.source_id, row.source_markdown_slug.as_deref()))
                .or_insert((Vec::new(), true));
            group.0.extend(row.row_num);
            group.1 &= row.expired_at_us.is_some();
        }
        Ok(groups
            .into_iter()
            .map(|((source_id, slug), (mut nums, expired))| {
                nums.sort_unstable();
                json!({ "source_id": source_id, "source_markdown_slug": slug, "row_nums": nums, "all_expired": expired })
            })
            .collect())
    }

    /// `readFactSubject` (src/core/belief/purge.ts): `{ source_id, slug }` of fact `id`, `slug` the row's page else
    /// its entity, or null for no such row.
    pub fn read_fact_subject(&self, id: f64) -> Result<Value> {
        let read = self.read()?;
        Ok(
            fact_by_number(&*read, "readFactSubject", "id", id)?.map_or(Value::Null, |r| {
                let slug = r.source_markdown_slug.as_ref().or(r.entity_slug.as_ref());
                json!({ "source_id": r.source_id, "slug": slug })
            }),
        )
    }

    /// `factsOrAliasesMayMatch` (src/commands/recall.ts `splitMayMatch`): whether a fact of the source is keyed under a
    /// slug a token matches (`slug_segment_match`), or a page alias row of the source is a listed alias.
    pub fn facts_or_aliases_may_match(&self, q: &MayMatchQuery) -> Result<bool> {
        let texts = q.slug_tokens.iter().chain(&q.alias_norms);
        let mut items = vec![("sourceId", q.source_id.as_str())];
        items.extend(texts.map(|t| ("token", t.as_str())));
        no_nul("factsOrAliasesMayMatch", &items)?;
        let read = self.read()?;
        if !q.slug_tokens.is_empty()
            && any_entity_slug(&*read, &q.source_id, &|slug| {
                q.slug_tokens.iter().any(|t| slug_segment_match(slug, t))
            })?
        {
            return Ok(true);
        }
        for alias in &q.alias_norms {
            if alias_row_exists(&*read, &q.source_id, alias)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `readFactForForget` (src/core/facts/forget.ts): `{ id, source_id, entity_slug, row_num, source_markdown_slug,
    /// expired_at, visibility }` of fact `id`, `expired_at` as `iso` text the TypeScript member turns into a `Date`, or
    /// null for no such row.
    pub fn read_fact_for_forget(&self, id: f64) -> Result<Value> {
        let read = self.read()?;
        Ok(
            fact_by_number(&*read, "readFactForForget", "id", id)?.map_or(Value::Null, |r| {
                json!({
                    "id": r.id,
                    "source_id": r.source_id,
                    "entity_slug": r.entity_slug,
                    "row_num": r.row_num,
                    "source_markdown_slug": r.source_markdown_slug,
                    "expired_at": r.expired_at_us.map(iso),
                    "visibility": r.visibility,
                })
            }),
        )
    }

    /// `listFactsForPage` (src/core/cycle/extract-facts.ts): the fence-owned rows of a page coordinate, by
    /// `row_num` (rows without one last) then id. Each row carries the 17 columns the statement selects and
    /// `has_embedding`; the times are `iso` text, which the TypeScript member turns into `Date`s.
    pub fn list_facts_for_page(&self, q: &PageCoordinate) -> Result<Vec<Value>> {
        no_nul(
            "listFactsForPage",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let mut rows: Vec<FactRecord> = page_rows(&*read, &q.source_id, &q.slug)?
            .into_iter()
            .filter(|r| {
                !r.source.starts_with("cli:") && !(r.row_num.is_none() && r.expired_at_us.is_some())
            })
            .collect();
        rows.sort_by_key(|r| (r.row_num.is_none(), r.row_num, r.id));
        let time = |us: Option<i64>| us.map(iso);
        Ok(rows
            .iter()
            .map(|r| {
                json!({
                    "id": r.id, "fact": r.fact, "source": r.source, "row_num": r.row_num,
                    "superseded_by": r.superseded_by, "expired_at": time(r.expired_at_us),
                    "kind": r.kind, "visibility": r.visibility, "notability": r.notability,
                    "context": r.context, "valid_from": r.valid_from().map(iso), "valid_until": time(r.valid_until_us),
                    "confidence": real(r.confidence), "claim_metric": r.claim_metric,
                    "claim_value": r.claim_value, "claim_unit": r.claim_unit, "claim_period": r.claim_period,
                    "has_embedding": r.embedding.is_some(),
                })
            })
            .collect())
    }

    /// `countLegacyFactsPending` (src/core/cycle/extract-facts.ts): per entity slug of the source, the unexpired
    /// rows with no `row_num` and no `dimension` whose entity is a live page, in a source that has a checkout.
    /// Each group is `{ entity_slug, n }`, by slug.
    pub fn count_legacy_facts_pending(&self, source_id: &str) -> Result<Vec<Value>> {
        const OP: &str = "countLegacyFactsPending";
        no_nul(OP, &[("sourceId", source_id)])?;
        let read = self.read()?;
        if !read_source(&*read, source_id)?.is_some_and(|s| s.local_path.is_some()) {
            return Ok(Vec::new());
        }
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        for row in super::source_rows(&*read, source_id)? {
            let Some(entity) = &row.entity_slug else {
                continue;
            };
            if row.row_num.is_none() && row.dimension.is_none() && row.expired_at_us.is_none() {
                *counts.entry(entity.clone()).or_default() += 1;
            }
        }
        let mut out = Vec::new();
        for (entity, n) in counts {
            if read_page(&*read, source_id, &entity)?.is_some_and(|p| p.deleted_at_us.is_none()) {
                out.push(json!({ "entity_slug": entity, "n": n }));
            }
        }
        Ok(out)
    }

    /// `countUnconsolidatedFactsBySource` (src/core/cycle/phases/consolidate.ts): per `(source_id, entity_slug)` the
    /// active, unconsolidated rows of a live entity page whose attribution is the user or none, that are world
    /// facts when `worldOnly`, and whose source page names no readers, for the buckets of at least `minPerBucket`.
    /// Each bucket is `{ source_id, entity_slug, count }`, by `(source, entity)`.
    pub fn count_unconsolidated_facts_by_source(&self, q: &BucketQuery) -> Result<Vec<Value>> {
        const OP: &str = "countUnconsolidatedFactsBySource";
        no_nul(OP, &[("sourceId", q.source_id.as_deref().unwrap_or(""))])?;
        let least = bigint(OP, "minPerBucket", q.min_per_bucket)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let rows = scan_rows(&*read, &mut |r| {
            r.consolidated_at_us.is_none()
                && r.active(now)
                && r.entity_slug.is_some()
                && r.attributed_to.as_deref().is_none_or(|a| a == "user")
                && (!q.world_only || r.visibility == "world")
                && q.source_id.as_deref().is_none_or(|s| s == r.source_id)
        })?;
        let mut buckets: BTreeMap<(&str, &str), i64> = BTreeMap::new();
        for row in &rows {
            let entity = row.entity_slug.as_deref().unwrap_or_default();
            if !read_page(&*read, &row.source_id, entity)?
                .is_some_and(|p| p.deleted_at_us.is_none())
            {
                continue;
            }
            // `readersSourcedFactSql`: the row's own page (deleted or not) names readers or sits
            // under a folder rule or a pending prefix.
            let readers = match &row.source_markdown_slug {
                Some(slug) => match read_page(&*read, &row.source_id, slug)? {
                    Some(p) => {
                        p.frontmatter.contains_key("readable_by") || folder_restricted(&*read, &p)?
                    }
                    None => false,
                },
                None => false,
            };
            if !readers {
                *buckets.entry((&row.source_id, entity)).or_default() += 1;
            }
        }
        Ok(buckets
            .into_iter()
            .filter(|(_, n)| *n >= least)
            .map(|((source_id, entity), n)| json!({ "source_id": source_id, "entity_slug": entity, "count": n }))
            .collect())
    }

    /// `findBulkFactDays` (src/core/facts/bulk-days.ts): the UTC days (of `valid_from`) of each unarchived source
    /// (`sourceIds` narrows them) whose unexpired rows number at least `min_facts`, at least `min_share` of the
    /// source's unexpired rows, over at least `min_entities` entity slugs. Each day is `{ source_id, day, facts,
    /// entities, source_facts, top_sources, dated_claims }`, by `(source, day)`: `top_sources` the five most
    /// frequent `source` tags as `{ source, facts }`, `dated_claims` the rows that state one earlier real date.
    pub fn find_bulk_fact_days(&self, q: &BulkDayQuery) -> Result<Vec<Value>> {
        const OP: &str = "findBulkFactDays";
        let narrowed = match &q.source_ids {
            Some(ids) => Some(distinct(OP, "sourceIds", ids)?),
            None => None,
        };
        let min_facts = bigint(OP, "min_facts", q.rule.min_facts)?;
        let min_entities = bigint(OP, "min_entities", q.rule.min_entities)?;
        let read = self.read()?;
        let mut out = Vec::new();
        let mut sources: Vec<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived && narrowed.as_ref().is_none_or(|n| n.contains(s.id.as_str())))
            .map(|s| s.id)
            .collect();
        sources.sort();
        for source in &sources {
            let active: Vec<FactRecord> = super::source_rows(&*read, source)?
                .into_iter()
                .filter(|r| r.expired_at_us.is_none())
                .collect();
            let total = active.len() as i64;
            let mut days: BTreeMap<String, Vec<&FactRecord>> = BTreeMap::new();
            for row in &active {
                // `a.day IS NOT NULL`: a fact with no event date is in the source's total and in no day.
                if let Some(from) = row.valid_from() {
                    days.entry(iso(from)[..10].to_string())
                        .or_default()
                        .push(row);
                }
            }
            for (day, rows) in days {
                let n = rows.len() as i64;
                let entities: BTreeSet<&str> = rows
                    .iter()
                    .filter_map(|r| r.entity_slug.as_deref())
                    .collect();
                if n < min_facts
                    || (n as f64) < total as f64 * q.rule.min_share
                    || (entities.len() as i64) < min_entities
                {
                    continue;
                }
                let mut tags: BTreeMap<&str, i64> = BTreeMap::new();
                for row in &rows {
                    *tags.entry(row.source.as_str()).or_default() += 1;
                }
                let mut tops: Vec<(&str, i64)> = tags.into_iter().collect();
                tops.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
                let top_sources: Vec<Value> = tops
                    .iter()
                    .take(5)
                    .map(|(s, n)| json!({ "source": s, "facts": n }))
                    .collect();
                let dated = rows.iter().filter(|r| dated_claim(&r.fact, &day)).count();
                out.push(json!({
                    "source_id": source, "day": day, "facts": n, "entities": entities.len(),
                    "source_facts": total, "top_sources": top_sources, "dated_claims": dated,
                }));
            }
        }
        Ok(out)
    }

    /// `maxFenceRowNum` (src/core/facts/fence-fact-append.ts): the largest `row_num` of a page coordinate's rows, 0 for none.
    pub fn max_fence_row_num(&self, q: &PageCoordinate) -> Result<i64> {
        no_nul(
            "maxFenceRowNum",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let rows = page_rows(&*read, &q.source_id, &q.slug)?;
        Ok(rows
            .iter()
            .filter_map(|r| r.row_num)
            .max()
            .map_or(0, i64::from)
            .max(0))
    }

    /// `readPageFileOrigin` (src/core/facts/unfenced-facts.ts, facts-home.ts, write-through.ts): `{ source_path,
    /// source_uri }` of the coordinate's page, or null for no page. A soft-deleted page answers only with
    /// `includeDeleted`.
    pub fn read_page_file_origin(&self, q: &PageFileOriginQuery) -> Result<Value> {
        no_nul(
            "readPageFileOrigin",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, &q.source_id, &q.slug)?
            .filter(|p| q.include_deleted || p.deleted_at_us.is_none())
            .map_or(
                Value::Null,
                |p| json!({ "source_path": p.source_path, "source_uri": p.source_uri }),
            ))
    }

    /// `readLiveStoredBody` (src/core/facts/file-body-guard.ts `readStoredBody`): `{ compiled_truth, timeline }` of
    /// the live page, or null for a deleted or missing page. A segmented page reads null columns, as PGLite's do. The
    /// caller's row lock is the store's writer gate, which a `transaction` already holds, so the read takes no lock.
    pub fn read_live_stored_body(&self, q: &PageCoordinate) -> Result<Value> {
        no_nul(
            "readLiveStoredBody",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, &q.source_id, &q.slug)?
            .filter(|p| p.deleted_at_us.is_none())
            .map_or(Value::Null, |p| {
                json!({ "compiled_truth": p.compiled_truth.as_deref(), "timeline": p.timeline.as_deref() })
            }))
    }

    /// `readFenceRowOccupant` (src/core/facts/fence-fact-append.ts): the id of the row of a page
    /// coordinate that holds `rowNum`, the oldest when several do, or none.
    pub fn read_fence_row_occupant(&self, q: &FenceRowOccupantQuery) -> Result<Option<u64>> {
        no_nul(
            "readFenceRowOccupant",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let rows = page_rows(&*read, &q.source_id, &q.slug)?;
        Ok(rows
            .iter()
            .filter(|r| r.row_num.is_some_and(|n| i64::from(n) == q.row_num))
            .map(|r| r.id)
            .min())
    }

    /// `listStoredFenceFactRows` (src/core/fence-repair/import-step.ts): `{ row_num, fact }` of a page coordinate's
    /// rows that hold a `row_num`, by id.
    pub fn list_stored_fence_fact_rows(&self, q: &PageCoordinate) -> Result<Vec<Value>> {
        no_nul(
            "listStoredFenceFactRows",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let mut rows = page_rows(&*read, &q.source_id, &q.slug)?;
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .iter()
            .filter(|r| r.row_num.is_some())
            .map(|r| json!({ "row_num": r.row_num, "fact": r.fact }))
            .collect())
    }

    /// `countWorldFacts` (src/core/verbs/entity-card.ts): the unexpired rows (a lapsed `valid_until` still counts)
    /// of the named entity slugs in one source, less the rows a soft-deleted or quarantined page hides, that are
    /// world facts when `worldOnly` and pass the private-provenance policy when `excludePrivate` carries one.
    pub fn count_world_facts(&self, q: &WorldFactCount) -> Result<u64> {
        const OP: &str = "countWorldFacts";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let slugs = distinct(OP, "entitySlugs", &q.entity_slugs)?;
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), q.suppress_flagged)?;
        let read = self.read()?;
        let mut count = 0;
        for slug in slugs {
            for row in super::entity_rows(&*read, &q.source_id, slug)? {
                if row.expired_at_us.is_none()
                    && (!q.world_only || row.visibility == "world")
                    && !hidden_by_policy(&*read, &row, &q.exclude_private)?
                    && !hidden_by_deleted_page(&*read, &row)?
                    && !hidden_by_quarantine(&*read, &row)?
                    && !super::hidden_by_rederive(&*read, &row)?
                    && trust.admits(&*read, "facts", row.id, row.tier())?
                {
                    count += 1;
                }
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::slug_segment_match;

    #[test]
    fn a_token_matches_a_slug_segment_start_as_the_regex_does() {
        // `(^|/)token(-|$)`, as recall's split pre-check reads entity_slug.
        assert!(slug_segment_match("companies/acme-example", "acme-example"));
        assert!(slug_segment_match("companies/acme-example", "acme"));
        assert!(slug_segment_match("acme-example", "acme"));
        assert!(slug_segment_match("companies/acme", "acme"));
        assert!(!slug_segment_match("companies/acme-example", "example"));
        assert!(!slug_segment_match("companies/acme-example", "acme-ex"));
        assert!(!slug_segment_match("companies/acmes", "acme"));
        // A later occurrence counts when the first does not.
        assert!(slug_segment_match("x-acme/acme-y", "acme"));
    }
}
