//! The belief ledger's coverage reads (src/core/belief/coverage.ts, engine-sql/belief-ledger.ts):
//! the newest coverage event of a source, and the activation baseline's progress in one run.
//!
//! No keys of their own. The coverage event comes from the subject index (`t 0x09 0x03`); the
//! baseline reads use the baseline index (`t 0x09 0x05 source \0 run \0 slug \0 id`, written by
//! [`super::belief_events`]), so a page's check and a run's count never walk the source's events.
//! The pending read joins the source's page keys (live and soft-deleted) and its facts.
//!
//! The drift scan's two reads sit here too: the candidate slugs ([`Store::list_belief_drift_candidates`]:
//! page keys, page-less fact entities and the incarnation's open lifetimes, most recently touched
//! first) and a slug's newest event ([`Store::read_newest_belief_event`]). The newest-event read
//! walks the incarnation's events newest first until one names the slug: the ledger keeps no
//! per-slug event index, and the drift scan asks for one slug at a time.

use super::belief_events::{BASELINE, EVENT, EVENTS, EventRecord, part_key};
use super::belief_history::{COVERAGE_KEY, id_range, index_entries, load_event, subject_prefix};
use super::belief_lifetimes::{LifetimeRecord, canonical_uuid, open_prefix, record_key};
use crate::cli_reads::entities::arrow_text;
use crate::env::iso;
use crate::error::Result;
use crate::facts::source_rows;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page};
use crate::sources::read_source;
use crate::{Store, get_json, keys};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// `readLatestBeliefCoverage`'s answer: the event type, `cause->>'run'`, `recorded_at` and id.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatestCoverage {
    pub event_type: String,
    pub run: Option<String>,
    pub recorded_at: String,
    pub id: u64,
}

/// `readNewestBeliefEvent`'s answer: the event's id, state hash and `recorded_at`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewestEvent {
    pub id: u64,
    pub state_hash: String,
    pub recorded_at: String,
}

/// One orphan finding of [`Store::list_orphan_lifetimes`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrphanLifetime {
    pub slug: String,
    pub page_lifetime: String,
    /// `no_page` (an open lifetime with no page row at its slug) or `no_lifetime` (an event naming a lifetime
    /// no lifetime record holds).
    pub reason: &'static str,
}

/// `orphanLifetimes`' answer: how many findings, and the first `limit` in byte order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrphanLifetimes {
    pub count: u64,
    pub samples: Vec<OrphanLifetime>,
}

/// `t 0x09 0x05 source \0 run \0`, or with the slug: `... slug \0`.
fn baseline_prefix(source: &str, run: &str, slug: Option<&str>) -> Vec<u8> {
    match slug {
        Some(slug) => part_key(&[keys::TRUST, EVENTS, BASELINE], &[source, run, slug], None),
        None => part_key(&[keys::TRUST, EVENTS, BASELINE], &[source, run], None),
    }
}

/// The distinct slugs with a baseline of `run` in the source, in byte order.
fn baselined_slugs(read: &dyn KvRead, source: &str, run: &str) -> Result<BTreeSet<String>> {
    let prefix = baseline_prefix(source, run, None);
    let mut out = BTreeSet::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        // The slug runs from the prefix to the NUL before the 8-byte id.
        if let Some(slug) = k.get(prefix.len()..k.len().saturating_sub(9)) {
            out.insert(String::from_utf8_lossy(slug).into_owned());
        }
        true
    })?;
    Ok(out)
}

impl Store {
    /// `readLatestBeliefCoverage`: the newest coverage event of the source's current incarnation
    /// other than `coverage.restored`, or none (and none for an unknown source).
    pub fn read_latest_belief_coverage(&self, source_id: &str) -> Result<Option<LatestCoverage>> {
        const OP: &str = "readLatestBeliefCoverage";
        no_nul(OP, &[("sourceId", source_id)])?;
        let read = self.read()?;
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(None);
        };
        let prefix = subject_prefix(source_id, "coverage", COVERAGE_KEY);
        for (inc, id) in index_entries(&*read, id_range(&prefix, 0, None), true)? {
            if inc != source.incarnation {
                continue;
            }
            let e = load_event(&*read, OP, source_id, &inc, id)?;
            if e.event_type != "coverage.restored" {
                return Ok(Some(LatestCoverage {
                    run: e.cause.get("run").and_then(arrow_text),
                    event_type: e.event_type,
                    recorded_at: iso(e.recorded_at_us),
                    id: e.id,
                }));
            }
        }
        Ok(None)
    }

    /// `hasBeliefBaseline`: whether the slug has a baseline event of `run` in the source (any
    /// incarnation, as the SQL reads it).
    pub fn has_belief_baseline(&self, source_id: &str, slug: &str, run: &str) -> Result<bool> {
        no_nul(
            "hasBeliefBaseline",
            &[("sourceId", source_id), ("slug", slug), ("runId", run)],
        )?;
        let read = self.read()?;
        let mut found = false;
        scan_prefix(
            &*read,
            &baseline_prefix(source_id, run, Some(slug)),
            false,
            &mut |_, _| {
                found = true;
                false
            },
        )?;
        Ok(found)
    }

    /// `countBeliefBaselineSlugs`: how many distinct slugs have a baseline event of `run`.
    pub fn count_belief_baseline_slugs(&self, source_id: &str, run: &str) -> Result<u64> {
        no_nul(
            "countBeliefBaselineSlugs",
            &[("sourceId", source_id), ("runId", run)],
        )?;
        let read = self.read()?;
        Ok(baselined_slugs(&*read, source_id, run)?.len() as u64)
    }

    /// `listBeliefBaselinePending`: the source's page slugs (live and soft-deleted), the entity
    /// slugs of its unexpired page-less facts and the page slugs of its unexpired fenceless
    /// dimension facts, after `after` in byte order, less `skip` and the slugs with a baseline of
    /// `run`; the first `limit`.
    pub fn list_belief_baseline_pending(
        &self,
        source_id: &str,
        run: &str,
        after: &str,
        skip: &[String],
        limit: usize,
    ) -> Result<Vec<String>> {
        no_nul(
            "listBeliefBaselinePending",
            &[("sourceId", source_id), ("runId", run), ("after", after)],
        )?;
        let read = self.read()?;
        let mut slugs = BTreeSet::new();
        let pages = keys::text(keys::PAGE, &[source_id, ""]);
        scan_prefix(&*read, &pages, false, &mut |k, _| {
            slugs.insert(String::from_utf8_lossy(&k[pages.len()..]).into_owned());
            true
        })?;
        for f in source_rows(&*read, source_id)? {
            if f.expired_at_us.is_some() {
                continue;
            }
            if f.source_markdown_slug.is_none() {
                slugs.extend(f.entity_slug);
            } else if f.dimension.is_some() && f.row_num.is_none() {
                slugs.extend(f.source_markdown_slug);
            }
        }
        let done = baselined_slugs(&*read, source_id, run)?;
        let skip: BTreeSet<&str> = skip.iter().map(String::as_str).collect();
        Ok(slugs
            .into_iter()
            .filter(|s| s.as_str() > after && !skip.contains(s.as_str()) && !done.contains(s))
            .take(limit)
            .collect())
    }

    /// `listBeliefDriftCandidates`: the slugs the drift scan may check, most recently touched first
    /// and byte order within a tie. A slug's time is the newest of its page row's `updated_at`
    /// (live or soft-deleted), its page-less facts' `created_at` (the facts of a fence page count
    /// for none) and the `started_at` of its open lifetime in `incarnation`.
    pub fn list_belief_drift_candidates(
        &self,
        source_id: &str,
        incarnation: &str,
    ) -> Result<Vec<String>> {
        no_nul(
            "listBeliefDriftCandidates",
            &[("sourceId", source_id), ("incarnation", incarnation)],
        )?;
        let incarnation = canonical_uuid(incarnation)?;
        let read = self.read()?;
        let mut touched: BTreeMap<String, i64> = BTreeMap::new();
        let mut touch = |slug: String, at: i64| {
            let newest = touched.entry(slug).or_insert(at);
            *newest = (*newest).max(at);
        };
        let pages = keys::text(keys::PAGE, &[source_id, ""]);
        let mut failure = None;
        scan_prefix(&*read, &pages, false, &mut |_, v| {
            match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => touch(page.slug, page.updated_at_us),
                Err(e) => {
                    failure = Some(crate::error::StoreError::from(e));
                    return false;
                }
            }
            true
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        for f in source_rows(&*read, source_id)? {
            if f.source_markdown_slug.is_none()
                && let Some(entity) = f.entity_slug
            {
                touch(entity, f.created_at_us);
            }
        }
        let open = open_prefix(&incarnation);
        let mut lifetimes = Vec::new();
        scan_prefix(&*read, &open, false, &mut |_, v| {
            lifetimes.push(String::from_utf8_lossy(v).into_owned());
            true
        })?;
        for lifetime in lifetimes {
            if let Some(rec) = get_json::<LifetimeRecord>(&*read, &record_key(&lifetime))?
                && rec.source_id == source_id
            {
                touch(rec.slug, rec.started_at_us);
            }
        }
        let mut slugs: Vec<(String, i64)> = touched.into_iter().collect();
        // The map is in byte order already; a stable sort keeps it within a tie.
        slugs.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
        Ok(slugs.into_iter().map(|(slug, _)| slug).collect())
    }

    /// `listOrphanLifetimes`: the source's open lifetimes of its current incarnation with no page row at
    /// their slug (a soft-deleted page is still a row), and, when `deep`, the events of the source (any
    /// incarnation) naming a page lifetime no lifetime record holds (in any source, as the SQL tests it),
    /// one finding per distinct slug and lifetime. Findings sort by slug then lifetime bytes; `count` is
    /// all of them and `samples` the first `max(1, limit)`. An unknown source has no open lifetimes, but
    /// its events still answer the deep read.
    pub fn list_orphan_lifetimes(
        &self,
        source_id: &str,
        limit: u32,
        deep: bool,
    ) -> Result<OrphanLifetimes> {
        no_nul("listOrphanLifetimes", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut found: BTreeSet<(Vec<u8>, String, &'static str)> = BTreeSet::new();
        if let Some(source) = read_source(&*read, source_id)? {
            let open = open_prefix(&source.incarnation);
            let mut lifetimes = Vec::new();
            scan_prefix(&*read, &open, false, &mut |_, v| {
                lifetimes.push(String::from_utf8_lossy(v).into_owned());
                true
            })?;
            for lifetime in lifetimes {
                let Some(rec) = get_json::<LifetimeRecord>(&*read, &record_key(&lifetime))? else {
                    continue;
                };
                if rec.source_id == source_id && read_page(&*read, source_id, &rec.slug)?.is_none()
                {
                    found.insert((rec.slug.into_bytes(), lifetime, "no_page"));
                }
            }
        }
        if deep {
            let prefix = part_key(&[keys::TRUST, EVENTS, EVENT], &[source_id], None);
            let mut named: BTreeSet<(String, String)> = BTreeSet::new();
            let mut failure = None;
            scan_prefix(&*read, &prefix, false, &mut |_, v| {
                match serde_json::from_slice::<EventRecord>(v) {
                    Ok(e) => {
                        if let Some(lifetime) = e.page_lifetime {
                            named.insert((e.slug, lifetime));
                        }
                    }
                    Err(err) => {
                        failure = Some(crate::error::StoreError::from(err));
                        return false;
                    }
                }
                true
            })?;
            if let Some(e) = failure {
                return Err(e);
            }
            for (slug, lifetime) in named {
                if get_json::<LifetimeRecord>(&*read, &record_key(&lifetime))?.is_none() {
                    found.insert((slug.into_bytes(), lifetime, "no_lifetime"));
                }
            }
        }
        let count = found.len() as u64;
        let samples = found
            .into_iter()
            .take((limit as usize).max(1))
            .map(|(slug, page_lifetime, reason)| OrphanLifetime {
                slug: String::from_utf8_lossy(&slug).into_owned(),
                page_lifetime,
                reason,
            })
            .collect();
        Ok(OrphanLifetimes { count, samples })
    }

    /// `readNewestBeliefEvent`: the newest event of the slug in the source's `incarnation` that is
    /// not a coverage event and not a backfill, or none.
    pub fn read_newest_belief_event(
        &self,
        source_id: &str,
        incarnation: &str,
        slug: &str,
    ) -> Result<Option<NewestEvent>> {
        no_nul(
            "readNewestBeliefEvent",
            &[
                ("sourceId", source_id),
                ("incarnation", incarnation),
                ("slug", slug),
            ],
        )?;
        let incarnation = canonical_uuid(incarnation)?;
        let read = self.read()?;
        let prefix = part_key(
            &[keys::TRUST, EVENTS, EVENT],
            &[source_id, &incarnation],
            None,
        );
        let mut found = None;
        let mut failure = None;
        scan_prefix(
            &*read,
            &prefix,
            true,
            &mut |_, v| match serde_json::from_slice::<EventRecord>(v) {
                Ok(e)
                    if e.slug == slug && e.subject_kind != "coverage" && e.origin != "backfill" =>
                {
                    found = Some(NewestEvent {
                        id: e.id,
                        state_hash: e.state_hash,
                        recorded_at: iso(e.recorded_at_us),
                    });
                    false
                }
                Ok(_) => true,
                Err(err) => {
                    failure = Some(crate::error::StoreError::from(err));
                    false
                }
            },
        )?;
        match failure {
            Some(e) => Err(e),
            None => Ok(found),
        }
    }
}

/// One coverage event of `readBeliefCoverageEvents` (coverage-report.ts `CoverageRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CoverageEventRow {
    pub id: u64,
    pub event_type: String,
    pub recorded_at: String,
    pub value: serde_json::Value,
    pub cause: serde_json::Value,
    pub incarnation: String,
}

impl Store {
    /// `readBeliefCoverageEvents(sourceId)`: every coverage event of the source's current
    /// incarnation, in id order (none for an unknown source), `value` and `cause` in jsonb order.
    pub fn read_belief_coverage_events(&self, source_id: &str) -> Result<Vec<CoverageEventRow>> {
        const OP: &str = "readBeliefCoverageEvents";
        no_nul(OP, &[("sourceId", source_id)])?;
        let read = self.read()?;
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(Vec::new());
        };
        let prefix = subject_prefix(source_id, "coverage", COVERAGE_KEY);
        let mut rows = Vec::new();
        for (inc, id) in index_entries(&*read, id_range(&prefix, 0, None), false)? {
            if inc != source.incarnation {
                continue;
            }
            let e = load_event(&*read, OP, source_id, &inc, id)?;
            rows.push(CoverageEventRow {
                id: e.id,
                event_type: e.event_type,
                recorded_at: iso(e.recorded_at_us),
                value: e
                    .value
                    .as_ref()
                    .map_or(serde_json::Value::Null, crate::jsonb::ordered),
                cause: crate::jsonb::ordered(&e.cause),
                incarnation: e.source_incarnation,
            });
        }
        rows.sort_by_key(|r| r.id);
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::{InsertFactArgs, InsertFactsArgs, NewFactInput};
    use crate::test_support::store;
    use crate::trust::belief_events::EventInsert;
    use serde_json::{Value, json};

    const PUB: &str = "22222222-2222-2222-2222-222222222222";

    fn incarnation(store: &Store) -> String {
        read_source(&*store.read().unwrap(), "default")
            .unwrap()
            .unwrap()
            .incarnation
    }

    fn event(store: &Store, key: &str, extra: Value) {
        let mut base = json!({
            "event_key": key, "source_id": "default", "source_incarnation": incarnation(store),
            "page_lifetime": null, "slug": "people/a", "subject_kind": "page", "subject_key": key,
            "event_type": "baseline", "origin": "baseline", "trust_tier": "owner", "writer_tier": null,
            "tier_basis": "row", "visibility": "world", "publication_id": PUB, "ord": 0,
            "source_time": null, "valid_from": null, "valid_until": null,
            "value": null, "value_hash": null, "prior_hash": null, "state_hash": "s",
            "cause": "{\"op\":\"baseline\",\"run\":\"r1\"}", "claim_fp": null, "purged": false,
            "redacted_fields": null,
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        let row: EventInsert = serde_json::from_value(base).unwrap();
        assert_eq!(store.insert_belief_events(&[row]).unwrap(), 1);
    }

    fn page(store: &Store, slug: &str) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "body", "timeline": "",
        }))
        .unwrap();
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    #[test]
    fn the_latest_coverage_skips_restores_and_reads_its_run() {
        let store = store();
        assert_eq!(store.read_latest_belief_coverage("default").unwrap(), None);
        let coverage = |kind: &str, cause: &str| json!({"slug": "", "subject_kind": "coverage", "subject_key": COVERAGE_KEY, "event_type": kind, "cause": cause});
        event(
            &store,
            "c1",
            coverage("coverage.started", "{\"run\":\"r1\"}"),
        );
        event(
            &store,
            "c2",
            coverage("coverage.restored", "{\"run\":\"r9\"}"),
        );
        let got = store
            .read_latest_belief_coverage("default")
            .unwrap()
            .unwrap();
        assert_eq!(
            (got.event_type.as_str(), got.run.as_deref(), got.id),
            ("coverage.started", Some("r1"), 1)
        );
        assert!(got.recorded_at.ends_with('Z'));
        event(&store, "c3", coverage("coverage.stopped", "{\"run\":5}"));
        let got = store
            .read_latest_belief_coverage("default")
            .unwrap()
            .unwrap();
        assert_eq!(
            (got.event_type.as_str(), got.run.as_deref()),
            ("coverage.stopped", Some("5"))
        );
        event(&store, "c4", coverage("coverage.started", "{}"));
        assert_eq!(
            store
                .read_latest_belief_coverage("default")
                .unwrap()
                .unwrap()
                .run,
            None
        );
        assert_eq!(store.read_latest_belief_coverage("nope").unwrap(), None);
    }

    #[test]
    fn the_baseline_reads_follow_the_run() {
        let store = store();
        event(&store, "b1", json!({"slug": "people/a"}));
        event(
            &store,
            "b2",
            json!({"slug": "people/a", "subject_kind": "fact"}),
        );
        event(&store, "b3", json!({"slug": "people/b"}));
        event(
            &store,
            "b4",
            json!({"slug": "people/c", "cause": "{\"run\":\"r2\"}"}),
        );
        event(
            &store,
            "b5",
            json!({"slug": "people/d", "event_type": "asserted", "origin": "live"}),
        );
        event(
            &store,
            "b6",
            json!({"slug": "people/e", "cause": "[\"r1\"]"}),
        );
        assert!(
            store
                .has_belief_baseline("default", "people/a", "r1")
                .unwrap()
        );
        assert!(
            !store
                .has_belief_baseline("default", "people/c", "r1")
                .unwrap()
        );
        assert!(
            !store
                .has_belief_baseline("default", "people/d", "r1")
                .unwrap()
        );
        assert!(
            !store
                .has_belief_baseline("default", "people/e", "r1")
                .unwrap()
        );
        assert!(
            !store
                .has_belief_baseline("default", "people", "r1")
                .unwrap()
        );
        assert!(
            !store
                .has_belief_baseline("other", "people/a", "r1")
                .unwrap()
        );
        assert_eq!(
            store.count_belief_baseline_slugs("default", "r1").unwrap(),
            2
        );
        assert_eq!(
            store.count_belief_baseline_slugs("default", "r2").unwrap(),
            1
        );
        assert_eq!(
            store.count_belief_baseline_slugs("default", "r3").unwrap(),
            0
        );
    }

    #[test]
    fn the_pending_slugs_join_pages_and_database_only_facts() {
        let store = store();
        for slug in ["people/b", "people/a", "notes/x"] {
            page(&store, slug);
        }
        store.soft_delete_page("notes/x", Some("default")).unwrap();
        let fact = |entity: Option<&str>, sms: Option<&str>, dim: Option<&str>| NewFactInput {
            fact: Some("f".into()),
            source: Some("test".into()),
            entity_slug: entity.map(Into::into),
            source_markdown_slug: sms.map(Into::into),
            dimension: dim.map(Into::into),
            value: dim.map(|_| "v".into()),
            value_hash: dim.map(|_| "vh".into()),
            ..NewFactInput::default()
        };
        // An entity of a page-less fact, and the page of a fenceless dimension fact.
        let insert = |input| {
            store
                .insert_fact(&InsertFactArgs {
                    input,
                    source_id: "default".into(),
                    supersede_id: None,
                })
                .unwrap();
        };
        insert(fact(Some("companies/z"), None, None));
        store
            .insert_facts(&InsertFactsArgs {
                rows: vec![
                    fact(Some("people/q"), Some("meetings/m"), Some("role")),
                    fact(Some("people/r"), Some("meetings/n"), None),
                    NewFactInput {
                        row_num: Some(1.0),
                        ..fact(Some("people/s"), Some("meetings/o"), Some("role"))
                    },
                ],
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        let all = store
            .list_belief_baseline_pending("default", "r1", "", &[], 200)
            .unwrap();
        assert_eq!(
            all,
            [
                "companies/z",
                "meetings/m",
                "notes/x",
                "people/a",
                "people/b"
            ]
        );
        event(&store, "b1", json!({"slug": "people/a"}));
        let after = store
            .list_belief_baseline_pending("default", "r1", "meetings/m", &["people/b".into()], 200)
            .unwrap();
        assert_eq!(after, ["notes/x"]);
        let first = store
            .list_belief_baseline_pending("default", "r2", "", &[], 2)
            .unwrap();
        assert_eq!(first, ["companies/z", "meetings/m"]);
        assert!(
            store
                .list_belief_baseline_pending("other", "r1", "", &[], 200)
                .unwrap()
                .is_empty()
        );
    }
    /// A clock the test moves, and ids drawn from a counter.
    struct Moving(std::sync::atomic::AtomicI64, std::sync::atomic::AtomicU64);
    impl crate::env::Env for Moving {
        fn now_micros(&self) -> i64 {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn new_uuid(&self) -> String {
            let n = self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            crate::env::uuid_from_bytes((n as u128).to_be_bytes())
        }
    }

    fn at(clock: &Moving, micros: i64) {
        clock.0.store(micros, std::sync::atomic::Ordering::SeqCst);
    }

    #[test]
    fn the_drift_candidates_are_newest_first_and_a_tie_is_in_byte_order() {
        use std::sync::Arc;
        let clock = Arc::new(Moving(1_000_000.into(), 0.into()));
        let store = crate::test_support::store_on(clock.clone());
        let inc = incarnation(&store);
        // Two pages tie at 1 s, one is newer, a lifetime with no page is older; a page-less fact's entity is
        // newer than the lifetime, and a fence page's fact counts for none.
        at(&clock, 1_000_000);
        page(&store, "people/b");
        page(&store, "notes/x");
        page(&store, "people/a");
        at(&clock, 500_000);
        store
            .mint_belief_lifetime(&crate::trust::belief_lifetimes::LifetimeMint {
                lifetime: Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into()),
                source_id: Some("default".into()),
                incarnation: Some(inc.clone()),
                slug: Some("ghost/l".into()),
                page_id: Some(1),
            })
            .unwrap();
        at(&clock, 700_000);
        let fact = |entity: &str, sms: Option<&str>| NewFactInput {
            fact: Some("f".into()),
            source: Some("test".into()),
            entity_slug: Some(entity.into()),
            source_markdown_slug: sms.map(Into::into),
            ..NewFactInput::default()
        };
        store
            .insert_facts(&InsertFactsArgs {
                rows: vec![
                    fact("companies/z", None),
                    NewFactInput {
                        row_num: Some(1.0),
                        ..fact("fence/e", Some("people/a"))
                    },
                ],
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        at(&clock, 2_000_000);
        page(&store, "notes/new");
        assert_eq!(
            store.list_belief_drift_candidates("default", &inc).unwrap(),
            [
                "notes/new",
                "notes/x",
                "people/a",
                "people/b",
                "companies/z",
                "ghost/l"
            ]
        );
        // A soft-deleted page row still counts; another incarnation's lifetimes and another source do not.
        store.soft_delete_page("notes/x", Some("default")).unwrap();
        let all = store.list_belief_drift_candidates("default", &inc).unwrap();
        assert!(all.contains(&"notes/x".to_string()));
        assert!(
            !store
                .list_belief_drift_candidates("default", "11111111-1111-1111-1111-111111111111")
                .unwrap()
                .contains(&"ghost/l".to_string())
        );
        assert!(
            store
                .list_belief_drift_candidates("other", &inc)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_newest_event_skips_coverage_backfill_and_other_slugs() {
        let store = store();
        let inc = incarnation(&store);
        assert_eq!(
            store
                .read_newest_belief_event("default", &inc, "people/a")
                .unwrap(),
            None
        );
        event(&store, "e1", json!({"state_hash": "h1"}));
        event(
            &store,
            "e2",
            json!({"state_hash": "h2", "subject_kind": "fact"}),
        );
        event(
            &store,
            "e3",
            json!({"state_hash": "h3", "slug": "people/b"}),
        );
        event(
            &store,
            "e4",
            json!({"state_hash": "h4", "origin": "backfill"}),
        );
        event(
            &store,
            "e5",
            json!({"state_hash": "h5", "subject_kind": "coverage", "subject_key": COVERAGE_KEY}),
        );
        let got = store
            .read_newest_belief_event("default", &inc, "people/a")
            .unwrap()
            .unwrap();
        assert_eq!((got.id, got.state_hash.as_str()), (2, "h2"));
        assert!(got.recorded_at.ends_with('Z'));
        let other = store
            .read_newest_belief_event("default", &inc, "people/b")
            .unwrap()
            .unwrap();
        assert_eq!(other.state_hash, "h3");
        assert_eq!(
            store
                .read_newest_belief_event(
                    "default",
                    "11111111-1111-1111-1111-111111111111",
                    "people/a"
                )
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .read_newest_belief_event("other", &inc, "people/a")
                .unwrap(),
            None
        );
    }
    #[test]
    fn the_orphan_lifetimes_are_open_lifetimes_with_no_page_row_and_deep_events_with_no_lifetime() {
        use crate::trust::belief_lifetimes::LifetimeMint;
        let store = store();
        let inc = incarnation(&store);
        let mint = |lifetime: &str, slug: &str| {
            store
                .mint_belief_lifetime(&LifetimeMint {
                    lifetime: Some(lifetime.into()),
                    source_id: Some("default".into()),
                    incarnation: Some(inc.clone()),
                    slug: Some(slug.into()),
                    page_id: Some(1),
                })
                .unwrap();
        };
        const L1: &str = "00000000-0000-4000-8000-000000000001";
        const L2: &str = "00000000-0000-4000-8000-000000000002";
        const L3: &str = "00000000-0000-4000-8000-000000000003";
        const L4: &str = "00000000-0000-4000-8000-000000000004";
        page(&store, "kept");
        mint(L1, "kept");
        mint(L2, "ab");
        mint(L3, "a-z");
        // A soft-deleted page is still a row, so its open lifetime is not an orphan.
        page(&store, "soft");
        store.soft_delete_page("soft", Some("default")).unwrap();
        mint(L4, "soft");
        let shallow = store.list_orphan_lifetimes("default", 1, false).unwrap();
        assert_eq!(shallow.count, 2);
        assert_eq!(
            shallow.samples,
            [OrphanLifetime {
                slug: "a-z".into(),
                page_lifetime: L3.into(),
                reason: "no_page"
            }]
        );
        // Events that name a lifetime no record holds count only when deep, once per slug and lifetime.
        let ghost = "00000000-0000-4000-8000-0000000000ff";
        event(&store, "a1", json!({"slug": "ab", "page_lifetime": ghost}));
        event(&store, "a2", json!({"slug": "ab", "page_lifetime": ghost}));
        event(&store, "a3", json!({"slug": "ab", "page_lifetime": L2}));
        assert_eq!(
            store
                .list_orphan_lifetimes("default", 9, false)
                .unwrap()
                .count,
            2
        );
        let deep = store.list_orphan_lifetimes("default", 9, true).unwrap();
        let found: Vec<(&str, &str, &str)> = deep
            .samples
            .iter()
            .map(|o| (o.slug.as_str(), o.page_lifetime.as_str(), o.reason))
            .collect();
        assert_eq!(
            found,
            [
                ("a-z", L3, "no_page"),
                ("ab", L2, "no_page"),
                ("ab", ghost, "no_lifetime")
            ]
        );
        assert_eq!(deep.count, 3);
        assert_eq!(
            store
                .list_orphan_lifetimes("default", 0, true)
                .unwrap()
                .samples
                .len(),
            1
        );
        // An unknown source has no open lifetimes and no events of its own.
        assert_eq!(
            store.list_orphan_lifetimes("nope", 9, true).unwrap().count,
            0
        );
    }
}
