//! The belief ledger's coverage reads (src/core/belief/coverage.ts, engine-sql/belief-ledger.ts):
//! the newest coverage event of a source, and the activation baseline's progress in one run.
//!
//! No keys of their own. The coverage event comes from the subject index (`t 0x09 0x03`); the
//! baseline reads use the baseline index (`t 0x09 0x05 source \0 run \0 slug \0 id`, written by
//! [`super::belief_events`]), so a page's check and a run's count never walk the source's events.
//! The pending read joins the source's page keys (live and soft-deleted) and its facts.

use super::belief_events::{BASELINE, EVENTS, part_key};
use super::belief_history::{COVERAGE_KEY, id_range, index_entries, load_event, subject_prefix};
use crate::cli_reads::entities::arrow_text;
use crate::env::iso;
use crate::error::Result;
use crate::facts::source_rows;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::sources::read_source;
use crate::{Store, keys};
use serde::Serialize;
use std::collections::BTreeSet;

/// `readLatestBeliefCoverage`'s answer: the event type, `cause->>'run'`, `recorded_at` and id.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatestCoverage {
    pub event_type: String,
    pub run: Option<String>,
    pub recorded_at: String,
    pub id: u64,
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
}
