//! The belief ledger's state reads (src/core/engine-sql/belief-state.ts, belief/state.ts): the
//! raw canonical state of belief streams, and fact rows by id for a guard event.
//!
//! No keys of their own. A stream is one slug of one source: its page (live or soft-deleted, at
//! `p source \0 slug`, or by id in the source), the fence facts it projects (the fact page index)
//! and the database-only facts about it (the fact entity index, no `source_markdown_slug`), its
//! takes (the take row index), and the links (the from-page and origin indexes) and transitions
//! whose origin, else from, page it is. Every part is read: the store keeps no per-transaction
//! write counters, so the answer's `counts` and `entity_pages` are null, as on a database with
//! `track_counts` off. Each row has the keys and the value kinds of the SQL read's JSON.

use super::TrustTier;
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{
    FactRecord, OwnerOnlySources, PrivacyPolicy, entity_rows, fact_fingerprint, page_hidden_with,
    page_rows, read_fact, real,
};
use crate::kv::KvRead;
use crate::link_queries::link_temporal::transitions_owned_by;
use crate::link_queries::origin_links;
use crate::links::{LinkRecord, no_nul, out_links};
use crate::page_body::purge_scan::page_is_segmented;
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::takes::{TakeRecord, page_takes, real_out};
use crate::version_prune::PAGE_INLINE_MAX_BYTES;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// `readBeliefStateRows`' arguments: the source, the stream slugs, pages added by id, the text
/// hashes whose fingerprints the caller already has, and the no-caller page policy
/// (`privatePagesFilterFragment('p')`) a page's `visible` is judged by.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeliefStateQuery {
    pub source_id: String,
    pub slugs: Vec<String>,
    pub page_ids: Vec<i64>,
    #[serde(default)]
    pub known_fp: BTreeMap<String, String>,
    pub visibility: PrivacyPolicy,
}

/// The answer: each part's rows in id order.
#[derive(Debug, Clone, Serialize)]
pub struct BeliefStateRows {
    pub pages: Vec<Value>,
    pub counts: Option<Vec<String>>,
    pub facts: Vec<Value>,
    pub entity_pages: Option<Vec<Value>>,
    pub takes: Vec<Value>,
    pub links: Vec<Value>,
    pub transitions: Vec<Value>,
    pub endpoints: Vec<Value>,
}

/// SHA-256 hex of a text (`encode(sha256(convert_to(t, 'UTF8')), 'hex')`).
fn text_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn opt_iso(us: Option<i64>) -> Value {
    us.map_or(Value::Null, |v| Value::String(iso(v)))
}

/// One fact row: the state read's columns, its page's id when the entity slug names a page of the
/// fact's source, and the fingerprint (from `known` when the text hash is there).
fn fact_row(read: &dyn KvRead, f: &FactRecord, known: &BTreeMap<String, String>) -> Result<Value> {
    let th = text_hash(&f.fact);
    let fp = known
        .get(&th)
        .cloned()
        .unwrap_or_else(|| fact_fingerprint(&f.fact));
    let entity_page_id = match &f.entity_slug {
        Some(slug) => read_page(read, &f.source_id, slug)?.map(|p| p.id),
        None => None,
    };
    Ok(json!({
        "id": f.id, "entity_slug": f.entity_slug, "sms": f.source_markdown_slug,
        "entity_page_id": entity_page_id, "fact": f.fact, "th": th, "fp": fp, "kind": f.kind,
        "visibility": f.visibility, "notability": f.notability, "context": f.context,
        "confidence": real(f.confidence), "valid_from": f.valid_from().map(iso),
        "valid_until": opt_iso(f.valid_until_us), "claim_metric": f.claim_metric,
        "claim_value": f.claim_value, "claim_unit": f.claim_unit, "claim_period": f.claim_period,
        "event_type": f.event_type, "dimension": f.dimension, "value": f.value,
        "value_hash": f.value_hash, "row_num": f.row_num, "trust_tier": f.tier().as_str(),
    }))
}

fn take_row(k: &TakeRecord, known: &BTreeMap<String, String>) -> Value {
    let th = text_hash(&k.claim);
    let claim_fp = known
        .get(&th)
        .cloned()
        .unwrap_or_else(|| fact_fingerprint(&k.claim));
    json!({
        "id": k.id, "page_id": k.page_id, "row_num": k.row_num, "claim": k.claim, "th": th,
        "claim_fp": claim_fp, "kind": k.kind, "holder": k.holder, "weight": real_out(k.weight),
        "since_date": k.since_date, "until_date": k.until_date, "source": k.source,
        "active": k.active, "resolved_at": opt_iso(k.resolved_at_us),
        "resolved_outcome": k.resolved_outcome, "resolved_value": k.resolved_value.map(real_out),
        "resolved_unit": k.resolved_unit, "resolved_source": k.resolved_source,
        "resolved_by": k.resolved_by, "resolved_quality": k.resolved_quality,
        "trust_tier": k.trust.tier().as_str(),
    })
}

fn link_row(l: &LinkRecord) -> Value {
    json!({
        "id": l.id, "f": l.from_page_id, "t": l.to_page_id, "o": l.origin_page_id,
        "link_type": l.link_type, "link_source": l.link_source, "context": l.context,
        "origin_field": l.origin_field, "link_kind": l.link_kind,
        "resolution_type": l.resolution_type, "assertion_tense": l.assertion_tense,
    })
}

/// A page's `large`: segmented, or an inline body over `PAGE_INLINE_MAX_BYTES` octets.
fn page_large(read: &dyn KvRead, p: &PageRecord) -> Result<bool> {
    Ok(page_is_segmented(read, p.id)?
        || (p.compiled_truth.len() + p.timeline.len()) as u64 > PAGE_INLINE_MAX_BYTES)
}

/// The incarnation of each source, read once.
struct Incarnations(BTreeMap<String, Option<String>>);

impl Incarnations {
    fn of(&mut self, read: &dyn KvRead, source: &str) -> Result<Option<String>> {
        if let Some(known) = self.0.get(source) {
            return Ok(known.clone());
        }
        let inc = read_source(read, source)?.map(|s| s.incarnation);
        self.0.insert(source.to_string(), inc.clone());
        Ok(inc)
    }
}

impl Store {
    /// `readBeliefStateRows`: the stream pages of `q.slugs` and `q.page_ids` in the source, their
    /// facts, takes, owned links and transitions, and those rows' endpoint pages.
    pub fn read_belief_state_rows(&self, q: &BeliefStateQuery) -> Result<BeliefStateRows> {
        const OP: &str = "readBeliefStateRows";
        no_nul(OP, &[("sourceId", q.source_id.as_str())])?;
        let read = self.read()?;
        let read = &*read;
        let source = q.source_id.as_str();
        let mut found: BTreeMap<u64, PageRecord> = BTreeMap::new();
        let mut stream: BTreeSet<String> = BTreeSet::new();
        for slug in &q.slugs {
            stream.insert(slug.clone());
            if let Some(p) = read_page(read, source, slug)? {
                found.insert(p.id, p);
            }
        }
        for id in q.page_ids.iter().filter_map(|id| u64::try_from(*id).ok()) {
            if let Some(p) = read_page_by_id(read, id)?.filter(|p| p.source_id == source) {
                stream.insert(p.slug.clone());
                found.insert(p.id, p);
            }
        }
        let owner_only = OwnerOnlySources::read(read)?;
        let mut incarnations = Incarnations(BTreeMap::new());
        let mut pages = Vec::with_capacity(found.len());
        for p in found.values() {
            let Some(incarnation) = incarnations.of(read, &p.source_id)? else {
                continue;
            };
            pages.push(json!({
                "id": p.id, "slug": p.slug, "deleted": p.deleted_at_us.is_some(),
                "revision": p.knowledge_revision, "content_hash": p.content_hash,
                "trust_tier": TrustTier::stored(p.trust_tier.as_deref()).as_str(),
                "visible": !page_hidden_with(read, p, &q.visibility, &owner_only)?,
                "incarnation": incarnation, "large": page_large(read, p)?,
            }));
        }
        let mut facts: BTreeMap<u64, FactRecord> = BTreeMap::new();
        for slug in &stream {
            for f in page_rows(read, source, slug)? {
                if f.expired_at_us.is_none() {
                    facts.insert(f.id, f);
                }
            }
            for f in entity_rows(read, source, slug)? {
                if f.expired_at_us.is_none() && f.source_markdown_slug.is_none() {
                    facts.insert(f.id, f);
                }
            }
        }
        let facts = facts
            .values()
            .map(|f| fact_row(read, f, &q.known_fp))
            .collect::<Result<Vec<_>>>()?;
        let mut takes: Vec<TakeRecord> = Vec::new();
        let mut links: BTreeMap<u64, LinkRecord> = BTreeMap::new();
        for id in found.keys() {
            takes.extend(page_takes(read, *id)?);
            for l in out_links(read, *id)? {
                if l.origin_page_id.is_none() {
                    links.insert(l.id, l);
                }
            }
            for l in origin_links(read, *id)? {
                links.insert(l.id, l);
            }
        }
        takes.sort_by_key(|k| k.id);
        let ids: BTreeSet<u64> = found.keys().copied().collect();
        let transitions = transitions_owned_by(read, &ids)?;
        let mut ends: BTreeSet<u64> = BTreeSet::new();
        for (f, t, o) in links
            .values()
            .map(|l| (l.from_page_id, l.to_page_id, l.origin_page_id))
            .chain(
                transitions
                    .iter()
                    .map(|x| (x.from_page_id, x.to_page_id, x.origin_page_id)),
            )
        {
            ends.extend([f, t]);
            ends.extend(o);
        }
        let mut endpoints = Vec::with_capacity(ends.len());
        for id in ends {
            let Some(p) = read_page_by_id(read, id)? else {
                continue;
            };
            if let Some(incarnation) = incarnations.of(read, &p.source_id)? {
                endpoints.push(json!({
                    "id": p.id, "slug": p.slug, "source_id": p.source_id, "incarnation": incarnation,
                }));
            }
        }
        Ok(BeliefStateRows {
            pages,
            counts: None,
            facts,
            entity_pages: None,
            takes: takes.iter().map(|k| take_row(k, &q.known_fp)).collect(),
            links: links.values().map(link_row).collect(),
            transitions: transitions
                .iter()
                .map(|x| {
                    json!({
                        "id": x.id, "f": x.from_page_id, "t": x.to_page_id, "o": x.origin_page_id,
                        "link_type": x.link_type, "kind": x.kind, "occurred_on": x.occurred_on,
                        "date_precision": x.date_precision, "producer": x.producer,
                        "line_hash": x.line_hash,
                    })
                })
                .collect(),
            endpoints,
        })
    }

    /// `readBeliefFactsById`: the facts among `ids` (any source, expired included), in the state
    /// read's columns with a fresh fingerprint, in id order.
    pub fn read_belief_facts_by_id(&self, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let none = BTreeMap::new();
        let ids: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(f) = read_fact(&*read, id)? {
                out.push(fact_row(&*read, &f, &none)?);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::{InsertFactArgs, NewFactInput};
    use crate::test_support::store;

    fn page(store: &Store, slug: &str) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "body", "timeline": "",
        }))
        .unwrap();
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    fn query(slugs: &[&str], page_ids: Vec<i64>) -> BeliefStateQuery {
        BeliefStateQuery {
            source_id: "default".into(),
            slugs: slugs.iter().map(|s| s.to_string()).collect(),
            page_ids,
            known_fp: BTreeMap::new(),
            visibility: PrivacyPolicy::default(),
        }
    }

    #[test]
    fn a_stream_reads_its_page_and_database_only_facts_and_a_fact_by_id() {
        let store = store();
        page(&store, "people/a");
        page(&store, "people/b");
        let inserted = store
            .insert_fact(&InsertFactArgs {
                input: NewFactInput {
                    fact: Some("A likes tea.".into()),
                    source: Some("test".into()),
                    entity_slug: Some("people/a".into()),
                    ..NewFactInput::default()
                },
                source_id: "default".into(),
                supersede_id: None,
            })
            .unwrap();
        let rows = store
            .read_belief_state_rows(&query(&["people/a", "people/none"], vec![]))
            .unwrap();
        let slugs: Vec<&str> = rows
            .pages
            .iter()
            .map(|p| p["slug"].as_str().unwrap())
            .collect();
        assert_eq!(slugs, ["people/a"]);
        assert_eq!(rows.pages[0]["visible"], json!(true));
        assert_eq!(rows.pages[0]["large"], json!(false));
        assert_eq!(rows.facts.len(), 1);
        assert_eq!(rows.facts[0]["fact"], json!("A likes tea."));
        assert_eq!(rows.facts[0]["th"].as_str().unwrap().len(), 64);
        assert!(rows.counts.is_none() && rows.entity_pages.is_none());

        // A page added by id joins the streams; the other stream's facts stay out.
        let b = read_page(&*store.read().unwrap(), "default", "people/b")
            .unwrap()
            .unwrap();
        let rows = store
            .read_belief_state_rows(&query(&[], vec![b.id as i64, -1]))
            .unwrap();
        assert_eq!(rows.pages.len(), 1);
        assert_eq!(rows.pages[0]["slug"], json!("people/b"));
        assert!(rows.facts.is_empty());

        let id = inserted["id"].as_i64().unwrap();
        let by_id = store.read_belief_facts_by_id(&[id, id + 100]).unwrap();
        assert_eq!(by_id.len(), 1);
        assert_eq!(by_id[0]["id"], json!(id));
        assert!(store.read_belief_facts_by_id(&[]).unwrap().is_empty());
    }
}
