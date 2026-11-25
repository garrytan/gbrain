//! The facts write-path, repair and fence-cycle reads and the one fence adoption write that left `executeRaw`
//! (src/core/engine-sql/facts-trust.ts and facts-cycle.ts):
//!
//! - `listLivePageTitles(sourceId, slugs)`: the slug and title of each named live page of the source.
//! - `listPageAliasNames(sourceId, slugs)`: the `(slug, alias_norm)` rows of the named pages of the source.
//! - `listCaptureDuplicateCandidates(opts)`: the live same-fingerprint facts a capture would duplicate, newest first.
//! - `computeFactFingerprints(texts)`: `gbrain_fact_fingerprint` of each text, in order.
//! - `listOversizedStaleFacts(opts)`: the embeddable stale facts longer than `maxTokens` bytes, by id, at most 10,000.
//! - `listLivePersonTitles(sourceId, slugs)`: the slug and title of each named live, non-retired person page.
//! - `listFenceRowClaims(sourceId, slug)`: `{ row_num, fact, source }` of the page coordinate's fenced rows.
//! - `adoptFactIntoFence(sourceId, id, rowNum, slug, fact)`: gives an unfenced row its fence row, page and claim.
//! - `readSourceCheckoutPath(sourceId)`: the source's `local_path`, or null.
//! - `listPageStates(sourceId, slug)`: the page row (deleted or not), then its 20 newest versions that hold a body.
//! - `countSegmentedVersionsOfPage(sourceId, slug)`: the page's versions with `body_storage = 'segmented'`.
//!
//! `readPendingWriteReceipt` and `lockSourceShared` are served in TypeScript (store-members/facts-write-path.ts) from
//! the request store and the writer gate. `readFactsFtsIndexState` and `swapFactsFtsIndex` read and rebuild a Postgres
//! index catalog the store does not have; they stay refused. Texts compare by bytes, as the parity brains' `C`
//! collation orders them.

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::{Value, json};

use super::doctor::CoverageQuery;
use super::withdrawal_guard::preserve_withdrawal;
use super::{bigint, page_rows, read_fact, source_rows, write_fact};
use crate::Store;
use crate::aliases::page_alias_rows;
use crate::cli_reads::reads::retired;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::links::no_nul;
use crate::pages::{read_page, versions_of};
use crate::sources::read_source;
use crate::trust::fingerprint::fact_fingerprint;

/// `OVERSIZED_SCAN_CAP` (src/core/facts/embedding-identity.ts).
const OVERSIZED_SCAN_CAP: usize = 10_000;
/// The page versions `listPageStates` reads after the page row.
const PAGE_STATE_VERSIONS: usize = 20;
/// The `source` prefix of the conversation extractor's rows (`source NOT LIKE 'cli:extract-conversation-facts%'`).
const CONVERSATION_SOURCE_PREFIX: &str = "cli:extract-conversation-facts";

/// `listLivePageTitles`, `listPageAliasNames` and `listLivePersonTitles`: a source and the slugs it names.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSlugsArgs {
    pub source_id: String,
    pub slugs: Vec<String>,
}

/// `listCaptureDuplicateCandidates(opts)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureDuplicateArgs {
    pub source_id: String,
    pub visibilities: Vec<String>,
    pub fact: String,
    #[serde(default)]
    pub attributed_to: Option<String>,
    #[serde(default)]
    pub replacing_page: Option<String>,
    pub scan_limit: f64,
}

/// `listOversizedStaleFacts(opts)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OversizedStaleArgs {
    #[serde(default)]
    pub source_id: Option<String>,
    pub model: String,
    pub dims: f64,
    pub max_tokens: f64,
}

/// `listFenceRowClaims`, `listPageStates` and `countSegmentedVersionsOfPage`: one page coordinate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageSlugArgs {
    pub source_id: String,
    pub slug: String,
}

/// `adoptFactIntoFence(sourceId, id, rowNum, slug, fact)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptFactArgs {
    pub source_id: String,
    pub id: String,
    pub row_num: f64,
    pub slug: String,
    pub fact: String,
}

/// The distinct slugs of `slug = ANY($2::text[])`, in byte order.
fn slug_set<'a>(op: &str, slugs: &'a [String]) -> Result<BTreeSet<&'a str>> {
    for slug in slugs {
        no_nul(op, &[("slugs", slug.as_str())])?;
    }
    Ok(slugs.iter().map(String::as_str).collect())
}

/// An `int4` parameter: a whole number in range, as Postgres casts it.
fn int4(op: &str, what: &str, value: f64) -> Result<i32> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= f64::from(i32::MAX) {
        Ok(value as i32)
    } else {
        Err(StoreError::invalid(format!(
            "{op}: invalid input syntax for type integer: \"{value}\" ({what})"
        )))
    }
}

impl Store {
    /// `listLivePageTitles(sourceId, slugs)`: `SELECT slug, title FROM pages WHERE source_id AND slug = ANY(slugs)
    /// AND deleted_at IS NULL`, by slug.
    pub fn list_live_page_titles(&self, a: &SourceSlugsArgs) -> Result<Vec<Value>> {
        self.live_titles("listLivePageTitles", a, false)
    }

    /// `listLivePersonTitles(sourceId, slugs)`: the live pages of `listLivePageTitles` that are `type = 'person'` and
    /// not retired (`retiredPageSql`), by slug.
    pub fn list_live_person_titles(&self, a: &SourceSlugsArgs) -> Result<Vec<Value>> {
        self.live_titles("listLivePersonTitles", a, true)
    }

    fn live_titles(&self, op: &str, a: &SourceSlugsArgs, people: bool) -> Result<Vec<Value>> {
        no_nul(op, &[("sourceId", a.source_id.as_str())])?;
        let slugs = slug_set(op, &a.slugs)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for slug in slugs {
            let Some(page) = read_page(&*read, &a.source_id, slug)? else {
                continue;
            };
            if page.deleted_at_us.is_some()
                || (people && (page.page_type != "person" || retired(&page.frontmatter)))
            {
                continue;
            }
            out.push(json!({ "slug": page.slug, "title": page.title }));
        }
        Ok(out)
    }

    /// `listPageAliasNames(sourceId, slugs)`: `SELECT slug, alias_norm FROM page_aliases WHERE source_id AND slug =
    /// ANY(slugs)`, by slug then alias. The rows outlive their page, so a deleted page's aliases are listed too.
    pub fn list_page_alias_names(&self, a: &SourceSlugsArgs) -> Result<Vec<Value>> {
        const OP: &str = "listPageAliasNames";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let slugs = slug_set(OP, &a.slugs)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for slug in slugs {
            for (alias, _origin) in page_alias_rows(&*read, &a.source_id, slug)? {
                out.push(json!({ "slug": slug, "alias_norm": alias }));
            }
        }
        Ok(out)
    }

    /// `listCaptureDuplicateCandidates(opts)`: `{ id, entity_slug, source, source_session, created_at }` of the facts
    /// of the source in `visibilities` whose fingerprint is the candidate's, unexpired and inside `valid_until`, spoken
    /// by nobody else (`attributed_to` null or `attributedTo`, any when `attributedTo` is null), not the
    /// conversation-extractor rows of `replacingPage`, and not on an owned memory page; newest first (`created_at`
    /// then id, descending), at most `scanLimit`.
    pub fn list_capture_duplicate_candidates(
        &self,
        a: &CaptureDuplicateArgs,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listCaptureDuplicateCandidates";
        let mut texts = vec![
            ("sourceId", a.source_id.as_str()),
            ("fact", a.fact.as_str()),
        ];
        texts.extend(a.attributed_to.as_deref().map(|t| ("attributedTo", t)));
        texts.extend(a.replacing_page.as_deref().map(|t| ("replacingPage", t)));
        texts.extend(a.visibilities.iter().map(|v| ("visibilities", v.as_str())));
        no_nul(OP, &texts)?;
        let limit = bigint(OP, "scanLimit", a.scan_limit)?;
        if limit < 0 {
            return Err(StoreError::invalid(format!(
                "{OP}: LIMIT must not be negative"
            )));
        }
        let print = fact_fingerprint(&a.fact);
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut rows: Vec<_> = source_rows(&*read, &a.source_id)?
            .into_iter()
            .filter(|r| {
                a.visibilities.contains(&r.visibility)
                    && r.expired_at_us.is_none()
                    && r.valid_until_us.is_none_or(|until| until > now)
                    && a.attributed_to
                        .as_ref()
                        .is_none_or(|who| r.attributed_to.as_ref().is_none_or(|said| said == who))
                    && a.replacing_page.as_ref().is_none_or(|page| {
                        r.source_markdown_slug.as_ref() != Some(page)
                            || !r.source.starts_with(CONVERSATION_SOURCE_PREFIX)
                    })
                    && !r.on_owned_memory_page()
            })
            .filter(|r| fact_fingerprint(&r.fact) == print)
            .collect();
        rows.sort_by_key(|x| std::cmp::Reverse((x.created_at_us, x.id)));
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(rows
            .into_iter()
            .map(|r| {
                json!({ "id": r.id, "entity_slug": r.entity_slug, "source": r.source,
                    "source_session": r.source_session, "created_at": iso(r.created_at_us) })
            })
            .collect())
    }

    /// `computeFactFingerprints(texts)`: `gbrain_fact_fingerprint` of each text, in input order.
    pub fn compute_fact_fingerprints(&self, texts: &[String]) -> Result<Vec<String>> {
        for text in texts {
            no_nul("computeFactFingerprints", &[("texts", text.as_str())])?;
        }
        Ok(texts.iter().map(|t| fact_fingerprint(t)).collect())
    }

    /// `listOversizedStaleFacts({ sourceId?, model, dims, maxTokens })`: `{ id, source_id, slug, fact }` (`id` as
    /// text) of the embeddable facts whose vector is stale for `model` and `dims` (`eligibleFactEmbedding` and
    /// `staleFactEmbedding`, the rows `countStaleFactEmbeddings` counts) and whose text is longer than `maxTokens`
    /// bytes (`octet_length(fact) > $5::int`), by id, at most `OVERSIZED_SCAN_CAP`.
    pub fn list_oversized_stale_facts(&self, a: &OversizedStaleArgs) -> Result<Vec<Value>> {
        const OP: &str = "listOversizedStaleFacts";
        let max = i64::from(int4(OP, "maxTokens", a.max_tokens)?);
        let q = CoverageQuery {
            source_id: a.source_id.clone(),
            model: a.model.clone(),
            dims: a.dims,
        };
        let mut rows = Vec::new();
        self.for_each_embeddable_fact(OP, &q, &mut |row, stale| {
            if stale && i64::try_from(row.fact.len()).unwrap_or(i64::MAX) > max {
                rows.push((
                    row.id,
                    row.source_id.clone(),
                    row.source_markdown_slug.clone(),
                    row.fact.clone(),
                ));
            }
        })?;
        rows.sort_by_key(|r| r.0);
        rows.truncate(OVERSIZED_SCAN_CAP);
        Ok(rows
            .into_iter()
            .map(|(id, source_id, slug, fact)| {
                json!({ "id": id.to_string(), "source_id": source_id, "slug": slug, "fact": fact })
            })
            .collect())
    }

    /// `listFenceRowClaims(sourceId, slug)`: `SELECT row_num, fact, source FROM facts WHERE source_id AND
    /// source_markdown_slug = slug AND row_num IS NOT NULL`, by id.
    pub fn list_fence_row_claims(&self, a: &PageSlugArgs) -> Result<Vec<Value>> {
        no_nul(
            "listFenceRowClaims",
            &[
                ("sourceId", a.source_id.as_str()),
                ("slug", a.slug.as_str()),
            ],
        )?;
        let read = self.read()?;
        let mut rows = page_rows(&*read, &a.source_id, &a.slug)?;
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                r.row_num
                    .map(|n| json!({ "row_num": n, "fact": r.fact, "source": r.source }))
            })
            .collect())
    }

    /// `adoptFactIntoFence(sourceId, id, rowNum, slug, fact)`: `UPDATE facts SET row_num = rowNum,
    /// source_markdown_slug = slug, fact = fact WHERE id AND source_id AND row_num IS NULL`. The `UPDATE` sets
    /// `fact`, a column `gbrain_preserve_fact_withdrawal` watches, so a withdrawal of the new claim expires the row;
    /// [`write_fact`] runs the trust stamp, the purge guard and the fence row's unique index (`23505`).
    pub fn adopt_fact_into_fence(&self, a: &AdoptFactArgs) -> Result<Value> {
        const OP: &str = "adoptFactIntoFence";
        no_nul(
            OP,
            &[
                ("sourceId", a.source_id.as_str()),
                ("slug", a.slug.as_str()),
                ("fact", a.fact.as_str()),
                ("id", a.id.as_str()),
            ],
        )?;
        let row_num = int4(OP, "rowNum", a.row_num)?;
        let id: i64 = a.id.trim().parse().map_err(|_| {
            StoreError::invalid(format!(
                "{OP}: invalid input syntax for type bigint: \"{}\" (id)",
                a.id
            ))
        })?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(Value::Null);
        };
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = read_fact(&*tx, id)? else {
                return Ok(Value::Null);
            };
            if old.source_id != a.source_id || old.row_num.is_some() {
                return Ok(Value::Null);
            }
            let mut new = old.clone();
            new.row_num = Some(row_num);
            new.source_markdown_slug = Some(a.slug.clone());
            new.fact = a.fact.clone();
            preserve_withdrawal(&*tx, &mut new)?;
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(Value::Null)
        })
    }

    /// `readSourceCheckoutPath(sourceId)`: `SELECT local_path FROM sources WHERE id`, null for an unknown source.
    pub fn read_source_checkout_path(&self, source_id: &str) -> Result<Option<String>> {
        no_nul("readSourceCheckoutPath", &[("sourceId", source_id)])?;
        let read = self.read()?;
        Ok(read_source(&*read, source_id)?.and_then(|s| s.local_path))
    }

    /// `listPageStates(sourceId, slug)`: `{ compiled_truth, timeline, frontmatter, title, type, tags }` of the page
    /// row (no `deleted_at` filter), then of its 20 newest versions that hold a body (`compiled_truth IS NOT NULL`),
    /// newest first. None when the page is missing.
    pub fn list_page_states(&self, a: &PageSlugArgs) -> Result<Vec<Value>> {
        no_nul(
            "listPageStates",
            &[
                ("sourceId", a.source_id.as_str()),
                ("slug", a.slug.as_str()),
            ],
        )?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, &a.source_id, &a.slug)? else {
            return Ok(Vec::new());
        };
        let mut out = vec![json!({
            "compiled_truth": page.compiled_truth.as_deref(), "timeline": page.timeline.as_deref(),
            "frontmatter": page.frontmatter, "title": page.title, "type": page.page_type, "tags": page.tags,
        })];
        let mut versions = versions_of(&*read, page.id)?;
        versions.retain(|v| !v.compiled_truth.is_null());
        versions.sort_by_key(|v| std::cmp::Reverse(v.id));
        out.extend(versions.into_iter().take(PAGE_STATE_VERSIONS).map(|v| {
            json!({
                "compiled_truth": v.compiled_truth.as_deref(), "timeline": v.timeline.as_deref(),
                "frontmatter": v.frontmatter, "title": v.title, "type": v.page_type, "tags": v.tags,
            })
        }));
        Ok(out)
    }

    /// `countSegmentedVersionsOfPage(sourceId, slug)`: the page's versions with `body_storage = 'segmented'`; 0 for
    /// a missing page.
    pub fn count_segmented_versions_of_page(&self, a: &PageSlugArgs) -> Result<u64> {
        no_nul(
            "countSegmentedVersionsOfPage",
            &[
                ("sourceId", a.source_id.as_str()),
                ("slug", a.slug.as_str()),
            ],
        )?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, &a.source_id, &a.slug)? else {
            return Ok(0);
        };
        Ok(versions_of(&*read, page.id)?
            .iter()
            .filter(|v| v.body_storage.as_deref() == Some("segmented"))
            .count() as u64)
    }
}
