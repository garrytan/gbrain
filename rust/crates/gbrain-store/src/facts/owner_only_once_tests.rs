//! The fact privacy policy reads the owner-only sources once per read, not once per fact row
//! (TODOS.md, "The Rust fact privacy check reads the owner-only sources again for every row").

use super::cycle::WorldFactCount;
use super::privacy::hidden_by_private_provenance;
use super::{
    FactQuery, FactRecord, InsertFactsArgs, OwnerOnlyCache, PrivacyPolicy, TrajectoryQuery,
    hidden_by_policy, source_rows,
};
use crate::error::Result;
use crate::kv::{Kv, KvRead, KvWrite};
use crate::owner_only::OwnerOnlyForm;
use crate::{OpenOptions, Store, SystemEnv, keys};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

/// A read that counts its scans of the source records (`all_sources`, the owner-only sources' read).
struct SourceScans(Box<dyn KvRead>, Arc<AtomicUsize>);

impl KvRead for SourceScans {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.0.get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        if start == [keys::SOURCE] {
            self.1.fetch_add(1, SeqCst);
        }
        self.0.scan(start, end, reverse, f)
    }
}

/// A record file whose snapshots count their source scans.
struct CountingKv(Arc<dyn Kv>, Arc<AtomicUsize>);

impl Kv for CountingKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        Ok(Box::new(SourceScans(self.0.snapshot()?, self.1.clone())))
    }
    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
        self.0.versioned_snapshot()
    }
    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        self.0.begin_write()
    }
    fn version(&self) -> Result<u64> {
        self.0.version()
    }
}

const ROWS: usize = 40;
const ENTITY: &str = "people/alice-example";

fn policy(form: OwnerOnlyForm) -> PrivacyPolicy {
    PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        owner_only: form,
        ..Default::default()
    }
}

/// A brain with an owner-only source `vault` beside `default`, and `ROWS` world facts about one
/// entity in each, half of each source's rows with a provenance page.
fn seeded() -> (Store, Arc<AtomicUsize>) {
    let scans = Arc::new(AtomicUsize::new(0));
    let kv = CountingKv(crate::test_support::mem_kv(), scans.clone());
    let store = Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    let source: crate::sources::SourceInput =
        serde_json::from_value(json!({ "id": "vault", "config": { "owner_only": true } })).unwrap();
    store.upsert_source(&source).unwrap();
    for source in ["default", "vault"] {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": "n", "compiled_truth": "x", "timeline": "", "frontmatter": {},
        }))
        .unwrap();
        let options = crate::pages::PutPageOptions {
            source_id: Some(source.to_string()),
            ..Default::default()
        };
        store.put_page("notes/n", &input, &options).unwrap();
        let rows: Vec<Value> = (0..ROWS)
            .map(|i| {
                let mut row = json!({
                    "fact": format!("{source} fact {i}"), "entity_slug": ENTITY, "visibility": "world",
                    "source": "t",
                });
                if i % 2 == 0 {
                    row["source_markdown_slug"] = json!("notes/n");
                    row["row_num"] = json!(i + 1);
                }
                row
            })
            .collect();
        let args: InsertFactsArgs =
            serde_json::from_value(json!({ "rows": rows, "sourceId": source })).unwrap();
        store.insert_facts(&args).unwrap();
    }
    (store, scans)
}

/// The source scans `run` makes.
fn scans_of<T>(scans: &AtomicUsize, run: impl FnOnce() -> T) -> (T, usize) {
    let before = scans.load(SeqCst);
    let out = run();
    (out, scans.load(SeqCst) - before)
}

/// Each read over `ROWS` facts under `excludePrivate` scans the source records once, whatever its
/// row count: before the cache, every row scanned them again (`ROWS` scans and more).
#[test]
fn a_private_fact_read_scans_the_owner_only_sources_once_per_read() {
    let (store, scans) = seeded();
    let count = |source: &str| WorldFactCount {
        source_id: source.to_string(),
        entity_slugs: vec![ENTITY.to_string()],
        world_only: true,
        exclude_private: Some(policy(OwnerOnlyForm::Fn)),
        ..Default::default()
    };
    let (n, used) = scans_of(&scans, || {
        store.count_world_facts(&count("default")).unwrap()
    });
    assert_eq!(
        (n, used),
        (ROWS as u64, 1),
        "countWorldFacts: rows, source scans"
    );
    let (n, used) = scans_of(&scans, || store.count_world_facts(&count("vault")).unwrap());
    assert_eq!(
        (n, used),
        (0, 1),
        "an owner-only source's facts stay hidden"
    );

    let by_entity = FactQuery {
        source_id: "default".into(),
        entity_slug: Some(ENTITY.into()),
        limit: 1000.0,
        exclude_private: Some(policy(OwnerOnlyForm::Fn)),
        ..Default::default()
    };
    let (rows, used) = scans_of(&scans, || store.list_facts_by_entity(&by_entity).unwrap());
    assert_eq!(
        (rows.len(), used),
        (ROWS, 1),
        "listFactsByEntity: rows, source scans"
    );

    let trajectory = TrajectoryQuery {
        source_ids: vec!["default".into(), "vault".into()],
        entity_slug: ENTITY.into(),
        limit: 1000.0,
        exclude_private: Some(policy(OwnerOnlyForm::Fn)),
        ..Default::default()
    };
    let (rows, used) = scans_of(&scans, || store.find_trajectory(&trajectory).unwrap());
    assert_eq!(
        (rows.len(), used),
        (ROWS, 1),
        "findTrajectory over both sources: rows, source scans"
    );

    // With no policy the read never looks at the sources.
    let open = WorldFactCount {
        exclude_private: None,
        ..count("default")
    };
    let (n, used) = scans_of(&scans, || store.count_world_facts(&open).unwrap());
    assert_eq!((n, used), (ROWS as u64, 0));
}

/// One cache over a list that mixes owner-only and open rows judges each row as a fresh read of the
/// sources does, in every owner-only form, and keeps the sources it read across the forms.
#[test]
fn the_cached_owner_only_judgement_equals_the_uncached_one_on_a_mixed_list() {
    let (store, scans) = seeded();
    let read = store.read().unwrap();
    let mut rows: Vec<FactRecord> = source_rows(&*read, "default").unwrap();
    rows.extend(source_rows(&*read, "vault").unwrap());
    // Interleave the two sources, so a cached answer for one source cannot pass for the other's.
    rows.sort_by_key(|r| (r.row_num, r.source_id.clone()));
    assert_eq!(rows.len(), 2 * ROWS);
    let mut cache = OwnerOnlyCache::default();
    for form in [OwnerOnlyForm::Fn, OwnerOnlyForm::Closed, OwnerOnlyForm::Off] {
        let policy = policy(form);
        let uncached: Vec<bool> = rows
            .iter()
            .map(|r| hidden_by_private_provenance(&*read, r, &policy).unwrap())
            .collect();
        let before = scans.load(SeqCst);
        let cached: Vec<bool> = rows
            .iter()
            .map(|r| hidden_by_policy(&*read, r, &Some(policy.clone()), &mut cache).unwrap())
            .collect();
        assert_eq!(cached, uncached, "{form:?}");
        assert!(
            scans.load(SeqCst) - before <= 1,
            "{form:?}: one scan at most"
        );
        let vault: Vec<bool> = rows.iter().map(|r| r.source_id == "vault").collect();
        match form {
            // The lineage form hides exactly the owner-only source's rows.
            OwnerOnlyForm::Fn => assert_eq!(cached, vault),
            // The closed form hides every row while the brain holds an owner-only source.
            OwnerOnlyForm::Closed => assert!(cached.iter().all(|h| *h)),
            // The owner's form hides none of these open-privacy rows.
            OwnerOnlyForm::Off => assert!(cached.iter().all(|h| !h)),
        }
    }
}
