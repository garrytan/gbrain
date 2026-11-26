//! The belief-ledger half of a purge (src/core/belief/purge.ts, belief/preimages.ts,
//! engine-sql/belief-purge-ledger.ts): the reads and writes a fact purge, a page purge and the
//! restore replay run on a source that records belief events.
//!
//! - `listDerivedStreamSlugs`: the stream slug of each derived row (a fact's fence page, else its
//!   entity; a take's page; a page itself) of the source.
//! - `listMissingPreimages`: the 1-based positions of the (page, revision) pairs no version of the
//!   page holds.
//! - `redactPurgedBeliefKeys`: the source's fact and take events with one of the fingerprints, and
//!   every event of the lifetimes, lose value, value hash and prior hash and are marked purged,
//!   unless already so. `legacyClaims` names claims that may have a pre-v341 Postgres fingerprint;
//!   the store has always folded the one explicit list, so none of its events carries such a
//!   fingerprint and the claims match nothing here (as `readLegacyClaimFingerprints` answers none).
//! - `listBeliefCarrierEvents`, `readBeliefEventValue`, `rewriteBeliefEventFields`,
//!   `rechainBeliefPriorHash`: the carrying-field redaction's keyset read, value read, rewrite (the
//!   prior hash stays only while an earlier event of the subject has it as value hash) and the
//!   re-chain of the subject's later events.
//! - `listBeliefQuotingRows`: the live facts (context), takes (resolution source) and links
//!   (context) of the source whose field is not empty, in id order.
//! - `listPageBeliefLifetimes`, `listPagePurgeLiveClaims`, `listPageVersionFenceBodies`,
//!   `listLifetimeClaimEvents`: the page purge's lifetimes and claim inventory.
//! - `listPurgeCarrierVersions`: retained versions of the source with whether their page passes the
//!   no-caller page policy (`privatePagesFilterFragment('p')`, sent as [`PrivacyPolicy`]).
//! - `listKnownBeliefSubjectKeys`: the subject keys that have an event in the source.
//!
//! Every keyset read answers at most [`LEDGER_PAGE`] rows after its cursor, in id order. The
//! statements read by event id or by lifetime alone; the store reads within the source the caller
//! names (an event, and a lifetime, belong to one source). Events are keyed per source incarnation
//! ([`super::belief_events`]), so a read gathers every incarnation of the source and sorts by id.

use super::belief_events::{EVENT, EVENTS, EventRecord, SUBJECT, event_key_of, part_key};
use super::belief_lifetimes::{LIFETIMES, LifetimeRecord, RECORD, canonical_uuid};
use super::fingerprint::fact_fingerprint;
use crate::cli_reads::entities::arrow_text;
use crate::error::{Result, StoreError};
use crate::facts::{OwnerOnlySources, PrivacyPolicy, page_hidden_with};
use crate::facts::{for_each_source_fact, page_rows, read_fact};
use crate::kv::{KvRead, scan_prefix};
use crate::link_queries::all_links;
use crate::pages::{read_page_by_id, versions_of};
use crate::takes::{all_takes, page_takes, read_take};
use crate::trust::tier_reads::all_versions;
use crate::{Store, get_json, keys, put_json};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The rows one keyset read answers (`LIMIT 1000`).
pub const LEDGER_PAGE: usize = 1000;

/// The subject kinds an event may have (`belief_events_subject_kind_check`).
const SUBJECT_KINDS: [&str; 6] = [
    "page",
    "fact",
    "take",
    "link",
    "link_transition",
    "coverage",
];

/// `listDerivedStreamSlugs`' argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedStreamQuery {
    pub source_id: String,
    pub fact_ids: Vec<i64>,
    pub take_ids: Vec<i64>,
    pub page_ids: Vec<i64>,
}

/// `listMissingPreimages`' argument: the pairs, as two parallel lists.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreimageQuery {
    pub page_ids: Vec<i64>,
    pub revisions: Vec<String>,
}

/// `redactPurgedBeliefKeys`' argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactPurgedKeys {
    pub source_id: String,
    pub claim_fps: Vec<String>,
    pub lifetimes: Vec<String>,
    pub legacy_claims: Vec<String>,
}

/// `rewriteBeliefEventFields`' argument: `value` is canonical JSON text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeliefEventRewrite {
    pub source_id: String,
    pub id: i64,
    pub value: String,
    pub value_hash: String,
    pub redacted_fields: Vec<String>,
}

/// `rechainBeliefPriorHash`' argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeliefPriorRechain {
    pub source_id: String,
    pub subject_key: String,
    pub old_hash: String,
    pub new_hash: String,
    pub after_id: i64,
}

/// `listPurgeCarrierVersions`' argument, with the no-caller page policy.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierVersionQuery {
    pub source_id: String,
    pub version_ids: Vec<i64>,
    pub visibility: PrivacyPolicy,
}

/// The first id a cursor `id > after` admits, or `None` when no id can (a NaN or huge cursor).
fn first_after(after: f64) -> Option<u64> {
    if after.is_nan() || after >= u64::MAX as f64 {
        None
    } else if after < 0.0 {
        Some(0)
    } else {
        Some(after.floor() as u64 + 1)
    }
}

/// The non-negative ids among `ids`, each once.
fn id_set(ids: &[i64]) -> BTreeSet<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

/// `value->>'field'`: the field as text, `None` for a missing field, JSON null or no value.
fn field_text(value: &Option<Value>, field: &str) -> Option<String> {
    value
        .as_ref()
        .and_then(|v| v.get(field))
        .and_then(arrow_text)
}

/// Every event of the source, across its incarnations, with its key, in id order.
fn source_events(read: &dyn KvRead, source_id: &str) -> Result<Vec<(Vec<u8>, EventRecord)>> {
    let mut out = Vec::new();
    let mut failure = None;
    let prefix = part_key(&[keys::TRUST, EVENTS, EVENT], &[source_id], None);
    scan_prefix(read, &prefix, false, &mut |k, v| {
        match serde_json::from_slice::<EventRecord>(v) {
            Ok(rec) => out.push((k.to_vec(), rec)),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    out.sort_by_key(|(_, rec)| rec.id);
    Ok(out)
}

/// The source's event with `id`, with its key.
fn find_event(
    read: &dyn KvRead,
    source_id: &str,
    id: u64,
) -> Result<Option<(Vec<u8>, EventRecord)>> {
    let mut incarnations = BTreeSet::new();
    let prefix = part_key(&[keys::TRUST, EVENTS, EVENT], &[source_id], None);
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some(nul) = k[prefix.len()..].iter().position(|b| *b == 0) {
            incarnations
                .insert(String::from_utf8_lossy(&k[prefix.len()..prefix.len() + nul]).into_owned());
        }
        true
    })?;
    for incarnation in incarnations {
        let key = event_key_of(source_id, &incarnation, id);
        if let Some(rec) = get_json::<EventRecord>(read, &key)? {
            return Ok(Some((key, rec)));
        }
    }
    Ok(None)
}

/// The events of one subject key of the source, of any kind, with their keys, in id order.
fn subject_events(
    read: &dyn KvRead,
    source_id: &str,
    subject_key: &str,
) -> Result<Vec<(Vec<u8>, EventRecord)>> {
    let mut out = Vec::new();
    for kind in SUBJECT_KINDS {
        let prefix = part_key(
            &[keys::TRUST, EVENTS, SUBJECT],
            &[source_id, kind, subject_key],
            None,
        );
        let mut found: Vec<(u64, String)> = Vec::new();
        scan_prefix(read, &prefix, false, &mut |k, v| {
            if let Some(id) = k.get(prefix.len()..).and_then(keys::be8) {
                found.push((id, String::from_utf8_lossy(v).into_owned()));
            }
            true
        })?;
        for (id, incarnation) in found {
            let key = event_key_of(source_id, &incarnation, id);
            if let Some(rec) = get_json::<EventRecord>(read, &key)? {
                out.push((key, rec));
            }
        }
    }
    out.sort_by_key(|(_, rec)| rec.id);
    Ok(out)
}

/// Whether the subject key has an event of any kind in the source.
fn subject_known(read: &dyn KvRead, source_id: &str, subject_key: &str) -> Result<bool> {
    for kind in SUBJECT_KINDS {
        let prefix = part_key(
            &[keys::TRUST, EVENTS, SUBJECT],
            &[source_id, kind, subject_key],
            None,
        );
        let mut any = false;
        scan_prefix(read, &prefix, false, &mut |_, _| {
            any = true;
            false
        })?;
        if any {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A page version's text column as JSON: its text, or null.
fn text_value(text: Option<&str>) -> Value {
    text.map_or(Value::Null, |t| Value::String(t.to_owned()))
}

impl Store {
    /// `listDerivedStreamSlugs`: `facts:<id>` with the fact's fence page, else its entity (a fact
    /// with neither is left out); `takes:<id>` with its page's slug; `pages:<id>` with its slug.
    /// Only rows of the source; facts, then takes, then pages, each in id order.
    pub fn list_derived_stream_slugs(&self, q: &DerivedStreamQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        let mut out = Vec::new();
        for id in id_set(&q.fact_ids) {
            if let Some(f) = read_fact(read, id)?.filter(|f| f.source_id == q.source_id)
                && let Some(slug) = f
                    .source_markdown_slug
                    .clone()
                    .or_else(|| f.entity_slug.clone())
            {
                out.push(json!({ "ref": format!("facts:{id}"), "slug": slug }));
            }
        }
        for id in id_set(&q.take_ids) {
            if let Some(t) = read_take(read, id)?
                && let Some(p) =
                    read_page_by_id(read, t.page_id)?.filter(|p| p.source_id == q.source_id)
            {
                out.push(json!({ "ref": format!("takes:{id}"), "slug": p.slug }));
            }
        }
        for id in id_set(&q.page_ids) {
            if let Some(p) = read_page_by_id(read, id)?.filter(|p| p.source_id == q.source_id) {
                out.push(json!({ "ref": format!("pages:{id}"), "slug": p.slug }));
            }
        }
        Ok(out)
    }

    /// `listMissingPreimages`: the 1-based position of each (page, revision) pair no version of
    /// the page holds (`unnest ... WITH ORDINALITY`), in position order. A revision that is not a
    /// UUID refuses, as its `::uuid` cast does.
    pub fn list_missing_preimages(&self, q: &PreimageQuery) -> Result<Vec<i64>> {
        let revisions = q
            .revisions
            .iter()
            .map(|r| canonical_uuid(r))
            .collect::<Result<Vec<_>>>()?;
        let read = self.read()?;
        let read = &*read;
        let mut out = Vec::new();
        for i in 0..q.page_ids.len().max(revisions.len()) {
            let held = match (
                q.page_ids.get(i).and_then(|id| u64::try_from(*id).ok()),
                revisions.get(i),
            ) {
                (Some(page_id), Some(revision)) => versions_of(read, page_id)?
                    .iter()
                    .any(|v| v.knowledge_revision == *revision),
                _ => false,
            };
            if !held {
                out.push(i as i64 + 1);
            }
        }
        Ok(out)
    }

    /// `redactPurgedBeliefKeys`: clears the matching events and answers how many it marked.
    pub fn redact_purged_belief_keys(&self, q: &RedactPurgedKeys) -> Result<u64> {
        let lifetimes = q
            .lifetimes
            .iter()
            .map(|l| canonical_uuid(l))
            .collect::<Result<BTreeSet<_>>>()?;
        let fps: BTreeSet<&str> = q.claim_fps.iter().map(String::as_str).collect();
        self.write(|tx| {
            let mut marked = 0u64;
            for (key, mut rec) in source_events(&*tx, &q.source_id)? {
                let by_claim = matches!(rec.subject_kind.as_str(), "fact" | "take")
                    && rec.claim_fp.as_deref().is_some_and(|fp| fps.contains(fp));
                let by_lifetime = rec
                    .page_lifetime
                    .as_ref()
                    .is_some_and(|l| lifetimes.contains(l));
                let pending = !rec.purged || rec.value.is_some() || rec.prior_hash.is_some();
                if (by_claim || by_lifetime) && pending {
                    rec.value = None;
                    rec.value_hash = None;
                    rec.prior_hash = None;
                    rec.purged = true;
                    put_json(tx, &key, &rec)?;
                    marked += 1;
                }
            }
            Ok(marked)
        })
    }

    /// `listBeliefCarrierEvents`: the next fact, take and link events of the source after
    /// `after` whose `context` or `resolved_source` is not empty, as text.
    pub fn list_belief_carrier_events(&self, source_id: &str, after: f64) -> Result<Vec<Value>> {
        let Some(from) = first_after(after) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut out = Vec::new();
        for (_, rec) in source_events(&*read, source_id)? {
            if rec.id < from || !matches!(rec.subject_kind.as_str(), "fact" | "take" | "link") {
                continue;
            }
            let context = field_text(&rec.value, "context");
            let resolved = field_text(&rec.value, "resolved_source");
            let filled = |t: &Option<String>| t.as_deref().is_some_and(|t| !t.is_empty());
            if !filled(&context) && !filled(&resolved) {
                continue;
            }
            out.push(json!({ "id": rec.id, "subject_kind": rec.subject_kind, "subject_key": rec.subject_key,
                "context": context, "resolved_source": resolved }));
            if out.len() == LEDGER_PAGE {
                break;
            }
        }
        Ok(out)
    }

    /// `readBeliefEventValue`: the source's event `id`'s value, value hash and redacted fields.
    pub fn read_belief_event_value(&self, source_id: &str, id: i64) -> Result<Option<Value>> {
        let Ok(id) = u64::try_from(id) else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(find_event(&*read, source_id, id)?.map(|(_, rec)| {
            json!({ "value": rec.value, "value_hash": rec.value_hash, "redacted_fields": rec.redacted_fields })
        }))
    }

    /// `rewriteBeliefEventFields`: the event's new value, value hash and redacted fields; its
    /// prior hash stays only while an earlier event of the same source and subject key has it as
    /// its value hash. No event with the id: nothing changes.
    pub fn rewrite_belief_event_fields(&self, q: &BeliefEventRewrite) -> Result<()> {
        let value = serde_json::from_str::<Value>(&q.value)
            .map(crate::jsonb::order)
            .map_err(|_| StoreError::invalid("invalid input syntax for type json"))?;
        let Ok(id) = u64::try_from(q.id) else {
            return Ok(());
        };
        self.write(|tx| {
            let Some((key, mut rec)) = find_event(&*tx, &q.source_id, id)? else {
                return Ok(());
            };
            let kept = match rec.prior_hash.as_deref() {
                Some(prior) => subject_events(&*tx, &rec.source_id, &rec.subject_key)?
                    .iter()
                    .any(|(_, o)| o.id < rec.id && o.value_hash.as_deref() == Some(prior)),
                None => false,
            };
            if !kept {
                rec.prior_hash = None;
            }
            rec.value = Some(value.clone());
            rec.value_hash = Some(q.value_hash.clone());
            rec.redacted_fields = Some(q.redacted_fields.clone());
            put_json(tx, &key, &rec)
        })
    }

    /// `rechainBeliefPriorHash`: the subject's events after `after_id` whose prior hash is
    /// `old_hash` take `new_hash`.
    pub fn rechain_belief_prior_hash(&self, q: &BeliefPriorRechain) -> Result<()> {
        self.write(|tx| {
            for (key, mut rec) in subject_events(&*tx, &q.source_id, &q.subject_key)? {
                if (rec.id as i128) > i128::from(q.after_id)
                    && rec.prior_hash.as_deref() == Some(q.old_hash.as_str())
                {
                    rec.prior_hash = Some(q.new_hash.clone());
                    put_json(tx, &key, &rec)?;
                }
            }
            Ok(())
        })
    }

    /// `listBeliefQuotingRows`: the next live rows of `kind` (`facts`, `takes` or `links`) of the
    /// source after `after` whose carrying field is not empty, as `{ id, slug, text }`.
    pub fn list_belief_quoting_rows(
        &self,
        kind: &str,
        source_id: &str,
        after: f64,
    ) -> Result<Vec<Value>> {
        let Some(from) = first_after(after) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let read = &*read;
        let filled = |t: &Option<String>| t.as_deref().is_some_and(|t| !t.is_empty());
        let mut rows: Vec<(u64, Option<String>, String)> = Vec::new();
        match kind {
            "facts" => {
                for_each_source_fact(read, source_id, &mut |f| {
                    if f.id >= from && f.expired_at_us.is_none() && filled(&f.context) {
                        let slug = f
                            .source_markdown_slug
                            .clone()
                            .or_else(|| f.entity_slug.clone());
                        rows.push((f.id, slug, f.context.clone().unwrap_or_default()));
                    }
                    true
                })?;
            }
            "takes" => {
                for t in all_takes(read)? {
                    if t.id < from || !filled(&t.resolved_source) {
                        continue;
                    }
                    if let Some(p) =
                        read_page_by_id(read, t.page_id)?.filter(|p| p.source_id == source_id)
                    {
                        rows.push((
                            t.id,
                            Some(p.slug),
                            t.resolved_source.clone().unwrap_or_default(),
                        ));
                    }
                }
            }
            "links" => {
                for l in all_links(read)? {
                    if l.id < from || l.context.is_empty() {
                        continue;
                    }
                    let Some(from_page) = read_page_by_id(read, l.from_page_id)? else {
                        continue;
                    };
                    let origin = match l.origin_page_id {
                        Some(id) => read_page_by_id(read, id)?,
                        None => None,
                    };
                    let (source, slug) = match &origin {
                        Some(o) => (o.source_id.as_str(), o.slug.clone()),
                        None => (from_page.source_id.as_str(), from_page.slug.clone()),
                    };
                    if source == source_id {
                        rows.push((l.id, Some(slug), l.context.clone()));
                    }
                }
            }
            other => {
                return Err(StoreError::invalid(format!(
                    "listBeliefQuotingRows: unknown kind {other}"
                )));
            }
        }
        rows.sort_by_key(|(id, _, _)| *id);
        rows.truncate(LEDGER_PAGE);
        Ok(rows
            .into_iter()
            .map(|(id, slug, text)| json!({ "id": id, "slug": slug, "text": text }))
            .collect())
    }

    /// `listPageBeliefLifetimes`: the source's lifetimes hinted at the page, and the open one at
    /// the slug with no page hint, in lifetime order.
    pub fn list_page_belief_lifetimes(
        &self,
        source_id: &str,
        slug: &str,
        page_id: i64,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let prefix = [keys::TRUST, LIFETIMES, RECORD];
        let mut out = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |k, v| {
            match serde_json::from_slice::<LifetimeRecord>(v) {
                Ok(rec) => {
                    let hinted = rec.page_id.is_some_and(|p| i64::from(p) == page_id);
                    let open_here =
                        rec.slug == slug && rec.ended_at_us.is_none() && rec.page_id.is_none();
                    if rec.source_id == source_id && (hinted || open_here) {
                        out.push(String::from_utf8_lossy(&k[prefix.len()..]).into_owned());
                    }
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        failure.map_or(Ok(out), Err)
    }

    /// `listPagePurgeLiveClaims`: each distinct (claim, fingerprint) of the source's facts whose
    /// fence page is the slug and of the page's takes, in claim order.
    pub fn list_page_purge_live_claims(
        &self,
        source_id: &str,
        slug: &str,
        page_id: i64,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        let mut claims: BTreeSet<String> = page_rows(read, source_id, slug)?
            .into_iter()
            .map(|f| f.fact)
            .collect();
        if let Ok(page_id) = u64::try_from(page_id) {
            claims.extend(page_takes(read, page_id)?.into_iter().map(|t| t.claim));
        }
        Ok(claims
            .into_iter()
            .map(|claim| json!({ "fp": fact_fingerprint(&claim), "claim": claim }))
            .collect())
    }

    /// `listPageVersionFenceBodies`: the next versions of the page after `after`, in id order.
    pub fn list_page_version_fence_bodies(&self, page_id: i64, after: f64) -> Result<Vec<Value>> {
        let (Ok(page_id), Some(from)) = (u64::try_from(page_id), first_after(after)) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut versions = versions_of(&*read, page_id)?;
        versions.retain(|v| v.id >= from);
        versions.sort_by_key(|v| v.id);
        versions.truncate(LEDGER_PAGE);
        Ok(versions
            .iter()
            .map(|v| {
                json!({ "id": v.id, "compiled_truth": text_value(v.compiled_truth.as_deref()),
                "timeline": text_value(v.timeline.as_deref()) })
            })
            .collect())
    }

    /// `listLifetimeClaimEvents`: the next fact and take events of the source's lifetimes after
    /// `after`, with the recorded claim (`fact`, else `claim`) and fingerprint.
    pub fn list_lifetime_claim_events(
        &self,
        source_id: &str,
        lifetimes: &[String],
        after: f64,
    ) -> Result<Vec<Value>> {
        let lifetimes = lifetimes
            .iter()
            .map(|l| canonical_uuid(l))
            .collect::<Result<BTreeSet<_>>>()?;
        let Some(from) = first_after(after) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut out = Vec::new();
        for (_, rec) in source_events(&*read, source_id)? {
            if rec.id < from
                || !matches!(rec.subject_kind.as_str(), "fact" | "take")
                || !rec
                    .page_lifetime
                    .as_ref()
                    .is_some_and(|l| lifetimes.contains(l))
            {
                continue;
            }
            let claim = field_text(&rec.value, "fact").or_else(|| field_text(&rec.value, "claim"));
            out.push(json!({ "id": rec.id, "claim": claim, "claim_fp": rec.claim_fp }));
            if out.len() == LEDGER_PAGE {
                break;
            }
        }
        Ok(out)
    }

    /// `listPurgeCarrierVersions`: the source's versions among the ids, in id order, with the
    /// page, its slug and whether it passes the no-caller page policy.
    pub fn list_purge_carrier_versions(&self, q: &CarrierVersionQuery) -> Result<Vec<Value>> {
        let ids = id_set(&q.version_ids);
        let read = self.read()?;
        let read = &*read;
        let owner_only = OwnerOnlySources::read(read)?;
        let mut versions = all_versions(read)?;
        versions.retain(|v| ids.contains(&v.id));
        versions.sort_by_key(|v| v.id);
        let mut pages = BTreeMap::new();
        let mut out = Vec::new();
        for v in versions {
            if !pages.contains_key(&v.page_id) {
                pages.insert(v.page_id, read_page_by_id(read, v.page_id)?);
            }
            let Some(Some(page)) = pages.get(&v.page_id) else {
                continue;
            };
            if page.source_id != q.source_id {
                continue;
            }
            let visible = !page_hidden_with(read, page, &q.visibility, &owner_only)?;
            out.push(json!({ "page_id": page.id, "slug": page.slug, "visible": visible,
                "compiled_truth": text_value(v.compiled_truth.as_deref()), "timeline": text_value(v.timeline.as_deref()) }));
        }
        Ok(out)
    }

    /// `listKnownBeliefSubjectKeys`: the keys among `keys` with an event in the source, in key order.
    pub fn list_known_belief_subject_keys(
        &self,
        source_id: &str,
        keys: &[String],
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for key in keys.iter().collect::<BTreeSet<_>>() {
            if subject_known(&*read, source_id, key)? {
                out.push(key.clone());
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;
    use crate::trust::belief_events::EventInsert;

    const INC: &str = "11111111-1111-1111-1111-111111111111";
    const INC2: &str = "33333333-3333-3333-3333-333333333333";
    const PUB: &str = "22222222-2222-2222-2222-222222222222";
    const LIFE: &str = "44444444-4444-4444-4444-444444444444";

    struct Ev<'a> {
        n: usize,
        source: &'a str,
        incarnation: &'a str,
        kind: &'a str,
        key: &'a str,
        value: Option<&'a str>,
        value_hash: Option<&'a str>,
        prior_hash: Option<&'a str>,
        claim_fp: Option<&'a str>,
        lifetime: Option<&'a str>,
    }

    fn ev<'a>(n: usize, kind: &'a str, key: &'a str, value: Option<&'a str>) -> Ev<'a> {
        Ev {
            n,
            source: "default",
            incarnation: INC,
            kind,
            key,
            value,
            value_hash: None,
            prior_hash: None,
            claim_fp: None,
            lifetime: None,
        }
    }

    fn insert(store: &Store, e: &Ev) {
        let row: EventInsert = serde_json::from_value(json!({
            "event_key": format!("{:04x}", e.n), "source_id": e.source, "source_incarnation": e.incarnation,
            "page_lifetime": e.lifetime, "slug": "people/a", "subject_kind": e.kind, "subject_key": e.key,
            "event_type": "asserted", "origin": "live", "trust_tier": "owner", "writer_tier": null,
            "tier_basis": "row", "visibility": "world", "publication_id": PUB, "ord": 1,
            "source_time": null, "valid_from": null, "valid_until": null, "value": e.value,
            "value_hash": e.value_hash, "prior_hash": e.prior_hash, "state_hash": "s", "cause": "{}", "claim_fp": e.claim_fp,
            "purged": false, "redacted_fields": null,
        }))
        .unwrap();
        store
            .insert_belief_events(std::slice::from_ref(&row))
            .unwrap();
    }

    fn event(store: &Store, id: u64) -> EventRecord {
        find_event(&*store.read().unwrap(), "default", id)
            .unwrap()
            .unwrap()
            .1
    }

    #[test]
    fn a_rewrite_keeps_its_prior_hash_only_while_an_earlier_event_has_it_and_a_rechain_moves_the_later_ones()
     {
        let store = store();
        insert(
            &store,
            &Ev {
                value_hash: Some("h1"),
                ..ev(1, "fact", "f1", Some(r#"{"context":"memo: the claim"}"#))
            },
        );
        insert(
            &store,
            &Ev {
                value_hash: Some("h2"),
                prior_hash: Some("h1"),
                ..ev(2, "fact", "f1", Some(r#"{"context":"the claim again"}"#))
            },
        );
        insert(
            &store,
            &Ev {
                value_hash: Some("h3"),
                prior_hash: Some("h2"),
                ..ev(3, "fact", "f1", Some(r#"{"context":"later"}"#))
            },
        );
        // Event 2's prior hash h1 is event 1's value hash: it stays through the rewrite.
        let rewrite = |id: i64, hash: &str| BeliefEventRewrite {
            source_id: "default".into(),
            id,
            value: r#"{"context":"[redacted]"}"#.into(),
            value_hash: hash.into(),
            redacted_fields: vec!["context".into()],
        };
        store
            .rewrite_belief_event_fields(&rewrite(2, "n2"))
            .unwrap();
        let two = event(&store, 2);
        assert_eq!(
            (two.prior_hash.as_deref(), two.value_hash.as_deref()),
            (Some("h1"), Some("n2"))
        );
        assert_eq!(two.value, Some(json!({ "context": "[redacted]" })));
        assert_eq!(two.redacted_fields, Some(vec!["context".to_string()]));
        // The later event chained to h2 follows the rewrite to n2.
        store
            .rechain_belief_prior_hash(&BeliefPriorRechain {
                source_id: "default".into(),
                subject_key: "f1".into(),
                old_hash: "h2".into(),
                new_hash: "n2".into(),
                after_id: 2,
            })
            .unwrap();
        assert_eq!(event(&store, 3).prior_hash.as_deref(), Some("n2"));
        // Event 1 rewritten: event 2 now has no earlier event with h1, so a rewrite of event 2 drops its prior hash.
        store
            .rewrite_belief_event_fields(&rewrite(1, "n1"))
            .unwrap();
        store
            .rewrite_belief_event_fields(&rewrite(2, "n2b"))
            .unwrap();
        assert_eq!(event(&store, 2).prior_hash, None);
        // An id with no event changes nothing.
        store
            .rewrite_belief_event_fields(&rewrite(99, "x"))
            .unwrap();
    }

    #[test]
    fn purged_keys_lose_their_values_once_and_other_kinds_and_sources_keep_theirs() {
        let store = store();
        insert(
            &store,
            &Ev {
                claim_fp: Some("fpX"),
                value_hash: Some("a"),
                ..ev(1, "fact", "f1", Some(r#"{"fact":"x"}"#))
            },
        );
        insert(
            &store,
            &Ev {
                claim_fp: Some("fpX"),
                incarnation: INC2,
                ..ev(2, "take", "t1", Some(r#"{"claim":"x"}"#))
            },
        );
        insert(
            &store,
            &Ev {
                claim_fp: Some("fpX"),
                ..ev(3, "link", "l1", Some(r#"{"context":"x"}"#))
            },
        );
        insert(
            &store,
            &Ev {
                lifetime: Some(LIFE),
                ..ev(4, "page", "p1", Some(r#"{"slug":"people/a"}"#))
            },
        );
        insert(
            &store,
            &Ev {
                claim_fp: Some("fpX"),
                source: "defaul",
                ..ev(5, "fact", "f1", Some(r#"{"fact":"x"}"#))
            },
        );
        let q = RedactPurgedKeys {
            source_id: "default".into(),
            claim_fps: vec!["fpX".into()],
            lifetimes: vec![LIFE.to_uppercase()],
            legacy_claims: vec!["x".into()],
        };
        assert_eq!(store.redact_purged_belief_keys(&q).unwrap(), 3);
        assert_eq!(store.redact_purged_belief_keys(&q).unwrap(), 0);
        let one = event(&store, 1);
        assert_eq!((one.value, one.value_hash, one.purged), (None, None, true));
        assert!(event(&store, 3).value.is_some());
        assert!(
            find_event(&*store.read().unwrap(), "defaul", 5)
                .unwrap()
                .unwrap()
                .1
                .value
                .is_some()
        );
        let bad = RedactPurgedKeys {
            lifetimes: vec!["not-a-uuid".into()],
            ..q
        };
        assert!(store.redact_purged_belief_keys(&bad).is_err());
    }

    #[test]
    fn carrier_events_and_lifetime_claims_read_every_incarnation_in_id_order_after_the_cursor() {
        let store = store();
        insert(
            &store,
            &ev(1, "fact", "f1", Some(r#"{"fact":"a","context":"memo"}"#)),
        );
        insert(
            &store,
            &Ev {
                incarnation: INC2,
                ..ev(
                    2,
                    "take",
                    "t1",
                    Some(r#"{"claim":"b","resolved_source":"said"}"#),
                )
            },
        );
        insert(
            &store,
            &ev(3, "fact", "f2", Some(r#"{"fact":"c","context":""}"#)),
        );
        insert(&store, &ev(4, "page", "p1", Some(r#"{"context":"page"}"#)));
        insert(
            &store,
            &Ev {
                lifetime: Some(LIFE),
                claim_fp: Some("fp5"),
                ..ev(5, "link", "l1", Some(r#"{"context":7}"#))
            },
        );
        let ids = |after: f64| -> Vec<u64> {
            store
                .list_belief_carrier_events("default", after)
                .unwrap()
                .iter()
                .map(|r| r["id"].as_u64().unwrap())
                .collect()
        };
        assert_eq!(ids(0.0), vec![1, 2, 5]);
        assert_eq!(ids(1.0), vec![2, 5]);
        assert_eq!(ids(f64::NAN), Vec::<u64>::new());
        assert_eq!(
            store.list_belief_carrier_events("default", 4.0).unwrap()[0]["context"],
            json!("7")
        );
        insert(
            &store,
            &Ev {
                lifetime: Some(LIFE),
                claim_fp: Some("fp6"),
                ..ev(6, "take", "t2", Some(r#"{"claim":"six"}"#))
            },
        );
        insert(
            &store,
            &Ev {
                lifetime: Some(LIFE),
                claim_fp: Some("fp7"),
                ..ev(7, "fact", "f7", Some(r#"{"fact":"seven","claim":"no"}"#))
            },
        );
        let claims = store
            .list_lifetime_claim_events("default", &[LIFE.into()], 0.0)
            .unwrap();
        assert_eq!(
            claims,
            vec![
                json!({ "id": 6, "claim": "six", "claim_fp": "fp6" }),
                json!({ "id": 7, "claim": "seven", "claim_fp": "fp7" })
            ]
        );
        assert_eq!(
            store
                .list_known_belief_subject_keys(
                    "default",
                    &["t2".into(), "nope".into(), "f1".into()]
                )
                .unwrap(),
            vec!["f1", "t2"]
        );
    }
}
