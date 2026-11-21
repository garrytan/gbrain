//! A page purge receipt's store probes (`countPurgeProbe` and `listPurgeProbeItems` of a `PurgeStoreProbe`, SQL in
//! `purgeStoreProbeSelect`, src/core/engine-sql/purge-verify.ts): after the purge, does any row, request, segment text or
//! effect still name what it removed? All of them read; none writes. Each count is capped at `rows + 1`, as the SQL's
//! bound is.
//!
//! Kinds served here, with the store each reads:
//! - `slug_key`: `pages` (a soft-deleted page counts), `facts` (by `source_markdown_slug`), `take_proposals`, `open_loops`,
//!   `page_aliases`, `slug_aliases` (by canonical slug), `eval_candidates.retrieved_slugs` (a slug a page of another covered
//!   source still holds does not count), `files` (detached, naming the slug) and `write_gate_holds`;
//! - `page_rows`: the page's chunks, versions, takes and timeline entries;
//! - `fact_refs`: the decide proposals and the review queue and proposals that name a fact id;
//! - `trust_proposals`, `page_requests`, `page_segment_texts`, `segment_texts` and `effect_payload`.
//!
//! The stores this crate keeps no rows of (`core_edit_notices`, `context_volunteer_events`, `mention_gazetteer_entries`,
//! `query_cache`, and the retrieval event, link, feedback and weight stores) are answered by the TypeScript member; a probe
//! of one that reaches this module refuses. `fingerprint` and `claim_text` are the fact purge's probes and refuse too.
//!
//! Text matching follows the SQL: `strpos(lower(COALESCE(x::text, '')), n) > 0` is `pg_lower(text).contains(n)` with a NULL
//! column read as the empty text, and a jsonb column's text is `jsonb_text`. The caller lowers the needles.

use super::invalid;
use crate::Store;
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::error::Result;
use crate::eval_capture::{count_retrieved_slug, decide_proposals::purge_review_counts};
use crate::journal::RequestRecord;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::persistence::effects::{EffectRecord, all_effects};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

/// `ORDER BY item LIMIT 20` of the effect probe.
const PROBE_ITEMS: usize = 20;

/// `{ probe, rows }`: one store probe and the bound of its count.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreProbeArgs {
    pub probe: StoreProbe,
    #[serde(default)]
    pub rows: Option<i64>,
}

/// The effect probe's second arm: the page's own Git effects.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectPage {
    pub slug: String,
    pub reason_forms: Vec<String>,
}

/// A `PurgeStoreProbe` of the kinds this store answers.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StoreProbe {
    SlugKey {
        store: String,
        source_id: String,
        slug: String,
    },
    PageRows {
        store: String,
        page_id: i64,
    },
    FactRefs {
        store: String,
        source_id: String,
        fact_ids: Vec<i64>,
    },
    TrustProposals {
        source_id: String,
        page_id: i64,
        fact_ids: Vec<i64>,
    },
    PageRequests {
        source_id: String,
        slug: String,
        request_id: String,
        needles: Vec<String>,
        reasons: Vec<String>,
    },
    PageSegmentTexts {
        source_id: String,
        shas: Vec<String>,
        forms: Vec<String>,
    },
    SegmentTexts {
        source_id: String,
        needles: Vec<String>,
        referenced: bool,
    },
    EffectPayload {
        source_id: String,
        forms: Vec<String>,
        #[serde(default)]
        page: Option<EffectPage>,
    },
}

/// `COALESCE(x::text, '')` of a nullable jsonb column.
fn jsonb_or_empty(value: Option<&Value>) -> String {
    value
        .filter(|v| !v.is_null())
        .map_or_else(String::new, jsonb_text)
}

fn any_in(text: &str, needles: &[String]) -> bool {
    let lowered = pg_lower(text);
    needles.iter().any(|n| lowered.contains(n.as_str()))
}

/// `data->>'key'`: a string as itself, any other non-null value as its jsonb text, null as NULL.
fn field_text(data: &Value, key: &str) -> Option<String> {
    match data.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// The requests of `source_id` that still name the page: another request, filed on the slug and finished, or whose intent,
/// outcome, error detail or error message holds a needle, or (on the slug) a reason.
fn requests_naming(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
    request_id: &str,
    needles: &[String],
    reasons: &[String],
) -> Result<usize> {
    let mut count = 0;
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        let r = match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) => r,
            Err(e) => {
                failure = Some(crate::StoreError::from(e));
                return false;
            }
        };
        if r.source_id != source_id || r.request_id.eq_ignore_ascii_case(request_id) {
            return true;
        }
        let on_slug = r.slug == slug;
        let finished = !r.intent.is_null()
            && matches!(
                r.state.as_str(),
                "committed" | "conflict" | "failed" | "cancelled"
            );
        let holds = |wanted: &[String]| {
            [
                jsonb_or_empty(Some(&r.intent)),
                jsonb_or_empty(r.outcome.as_ref()),
                jsonb_or_empty(r.extra.get("error_detail")),
                r.error_message.clone().unwrap_or_default(),
            ]
            .iter()
            .any(|text| any_in(text, wanted))
        };
        if (on_slug && finished) || holds(needles) || (on_slug && holds(reasons)) {
            count += 1;
        }
        true
    })?;
    failure.map_or(Ok(count), Err)
}

/// The effects of `source_id` whose payload holds a form, or (given the page) its Git effects on the slug whose data holds a
/// reason form, as `effect:<id> <kind> <state>` items.
fn effect_items(
    read: &dyn KvRead,
    source_id: &str,
    forms: &[String],
    page: Option<&EffectPage>,
) -> Result<Vec<String>> {
    let mut items = Vec::new();
    for e in all_effects(read)? {
        if e.source_id.as_deref() != Some(source_id) {
            continue;
        }
        let data = jsonb_text(&e.data);
        let named = any_in(&data, forms)
            || any_in(&jsonb_or_empty(e.outcome.as_ref()), forms)
            || any_in(&jsonb_or_empty(e.recovery.as_ref()), forms);
        let own = page.is_some_and(|p| {
            e.kind == "git"
                && field_text(&e.data, "slug").as_deref() == Some(p.slug.as_str())
                && any_in(&data, &p.reason_forms)
        });
        if named || own {
            items.push(item_of(&e));
        }
    }
    Ok(items)
}

fn item_of(e: &EffectRecord) -> String {
    format!("effect:{} {} {}", e.id, e.kind, e.state)
}

fn page_u64(page_id: i64) -> Option<u64> {
    u64::try_from(page_id).ok()
}

impl StoreProbe {
    fn check(&self, op: &str) -> Result<()> {
        let nul = |parts: &[(&str, &str)]| no_nul(op, parts);
        let list = |name: &str, items: &[String]| -> Result<()> {
            items
                .iter()
                .try_for_each(|item| no_nul(op, &[(name, item.as_str())]))
        };
        match self {
            StoreProbe::SlugKey {
                store,
                source_id,
                slug,
            } => nul(&[("store", store), ("sourceId", source_id), ("slug", slug)]),
            StoreProbe::PageRows { store, .. } => nul(&[("store", store)]),
            StoreProbe::FactRefs {
                store, source_id, ..
            } => nul(&[("store", store), ("sourceId", source_id)]),
            StoreProbe::TrustProposals { source_id, .. } => nul(&[("sourceId", source_id)]),
            StoreProbe::PageRequests {
                source_id,
                slug,
                request_id,
                needles,
                reasons,
            } => {
                nul(&[
                    ("sourceId", source_id),
                    ("slug", slug),
                    ("requestId", request_id),
                ])?;
                list("needles", needles)?;
                list("reasons", reasons)
            }
            StoreProbe::PageSegmentTexts {
                source_id,
                shas,
                forms,
            } => {
                nul(&[("sourceId", source_id)])?;
                list("shas", shas)?;
                list("forms", forms)
            }
            StoreProbe::SegmentTexts {
                source_id, needles, ..
            } => {
                nul(&[("sourceId", source_id)])?;
                list("needles", needles)
            }
            StoreProbe::EffectPayload {
                source_id,
                forms,
                page,
            } => {
                nul(&[("sourceId", source_id)])?;
                list("forms", forms)?;
                if let Some(p) = page {
                    nul(&[("slug", &p.slug)])?;
                    list("reasonForms", &p.reason_forms)?;
                }
                Ok(())
            }
        }
    }

    /// How many rows match, uncapped.
    fn count(&self, read: &dyn KvRead, op: &str) -> Result<usize> {
        match self {
            StoreProbe::SlugKey {
                store,
                source_id,
                slug,
            } => slug_key(read, store, source_id, slug, op),
            StoreProbe::PageRows { store, page_id } => {
                let Some(id) = page_u64(*page_id) else {
                    return Ok(0);
                };
                match store.as_str() {
                    "content_chunks" => Ok(crate::chunks::read_chunks(read, id)?.len()),
                    "page_versions" => Ok(crate::pages::versions_of(read, id)?.len()),
                    "takes" => Ok(crate::takes::page_takes(read, id)?.len()),
                    "timeline_entries" => {
                        let mut n = 0;
                        scan_prefix(read, &keys::timeline_prefix(id), false, &mut |_, _| {
                            n += 1;
                            true
                        })?;
                        Ok(n)
                    }
                    other => Err(invalid(format!("{op}: the {other} page rows are not kept"))),
                }
            }
            StoreProbe::FactRefs {
                store,
                source_id,
                fact_ids,
            } => {
                let refs: HashSet<String> = fact_ids.iter().map(i64::to_string).collect();
                let ids: HashSet<i64> = fact_ids.iter().copied().collect();
                let (queue, review, supersede) = purge_review_counts(read, source_id, &refs, &ids)?;
                let n = match store.as_str() {
                    "decide_review_queue" => queue,
                    "decide_review_proposals" => review,
                    "decide_proposals" => supersede,
                    other => {
                        return Err(invalid(format!("{op}: the {other} fact refs are not kept")));
                    }
                };
                Ok(n as usize)
            }
            StoreProbe::TrustProposals {
                source_id,
                page_id,
                fact_ids,
            } => crate::trust::proposals::purge::count_naming(read, source_id, *page_id, fact_ids),
            StoreProbe::PageRequests {
                source_id,
                slug,
                request_id,
                needles,
                reasons,
            } => requests_naming(read, source_id, slug, request_id, needles, reasons),
            StoreProbe::PageSegmentTexts {
                source_id,
                shas,
                forms,
            } => crate::page_body::purge_probe::count_page_texts(read, source_id, shas, forms),
            StoreProbe::SegmentTexts {
                source_id,
                needles,
                referenced,
            } => crate::page_body::purge_probe::count_texts_holding(
                read,
                source_id,
                needles,
                *referenced,
            ),
            StoreProbe::EffectPayload {
                source_id,
                forms,
                page,
            } => Ok(effect_items(read, source_id, forms, page.as_ref())?.len()),
        }
    }
}

fn slug_key(
    read: &dyn KvRead,
    store: &str,
    source_id: &str,
    slug: &str,
    op: &str,
) -> Result<usize> {
    match store {
        "pages" => Ok(usize::from(
            crate::pages::read_page(read, source_id, slug)?.is_some(),
        )),
        "facts" => Ok(super::page_rows(read, source_id, slug)?.len()),
        "take_proposals" => crate::takes::proposals::count_for_slug(read, source_id, slug),
        "open_loops" => super::loops::count_for_slug(read, source_id, slug),
        "page_aliases" => crate::aliases::count_alias_rows(read, source_id, slug, false),
        "slug_aliases" => crate::aliases::count_alias_rows(read, source_id, slug, true),
        "eval_candidates.retrieved_slugs" => count_retrieved_slug(read, source_id, slug),
        "files" => crate::raw_files::purge::count_detached_named(read, source_id, slug),
        "write_gate_holds" => crate::trust::write_gate::count_for_slug(read, source_id, slug),
        other => Err(invalid(format!("{op}: the {other} rows are not kept"))),
    }
}

impl Store {
    /// `countPurgeProbe` of a store probe: the matching rows, at most `rows + 1`.
    pub fn count_purge_store_probe(&self, q: &StoreProbeArgs) -> Result<i64> {
        const OP: &str = "countPurgeStoreProbe";
        q.probe.check(OP)?;
        let rows = q
            .rows
            .ok_or_else(|| invalid(format!("{OP}: rows is required")))?;
        let cap = usize::try_from(rows)
            .map_err(|_| invalid(format!("{OP}: rows must not be negative")))?
            .saturating_add(1);
        let read = self.read()?;
        Ok(q.probe.count(&*read, OP)?.min(cap) as i64)
    }

    /// `listPurgeProbeItems` of an effect probe: the first 20 `effect:<id> <kind> <state>` items in byte order. A probe of
    /// another kind names no item and refuses.
    pub fn list_purge_store_probe_items(&self, q: &StoreProbeArgs) -> Result<Value> {
        const OP: &str = "listPurgeStoreProbeItems";
        q.probe.check(OP)?;
        let StoreProbe::EffectPayload {
            source_id,
            forms,
            page,
        } = &q.probe
        else {
            return Err(invalid(format!(
                "{OP}: only an effect probe names its rows"
            )));
        };
        let read = self.read()?;
        let mut items = effect_items(&*read, source_id, forms, page.as_ref())?;
        items.sort();
        items.truncate(PROBE_ITEMS);
        Ok(json!(items))
    }
}
