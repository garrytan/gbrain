//! Tests of `entity_order.rs` on both store modes (single writer and `occ_kv`): conformance C10 (the facts of one
//! entity form one total order, no lost fact) and C11 (that order is commit order), plus the off-mode proofs.

use super::*;
use crate::OpenOptions;
use crate::env::Env;
use crate::error::WRITE_CONFLICT;
use crate::facts::{InsertFactArgs, InsertFactsArgs, NewFactInput, PageDeleteArgs};
use crate::kv::{Kv, scan_prefix};
use crate::test_support::{mem_kv, occ_kv};
use serde_json::json;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Barrier, Mutex};

const THREADS: usize = 8;
const PER_THREAD: usize = 12;

/// A clock that stands still and ids from a counter, so two stores given the same calls write the same rows.
struct Fixed {
    ids: AtomicU64,
    now: AtomicI64,
}

impl Env for Fixed {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        format!(
            "00000000-0000-4000-8000-{:012x}",
            self.ids.fetch_add(1, Ordering::SeqCst)
        )
    }
}

fn fixed() -> Arc<Fixed> {
    Arc::new(Fixed {
        ids: AtomicU64::new(1),
        now: AtomicI64::new(1_800_000_000_000_000),
    })
}

fn kvs() -> [(&'static str, Arc<dyn Kv>); 2] {
    [("single", mem_kv()), ("concurrent", Arc::new(occ_kv()))]
}

fn open(kv: Arc<dyn Kv>, multiuser: bool) -> Store {
    Store::open_kv(
        kv,
        fixed(),
        OpenOptions {
            multiuser,
            ..OpenOptions::default()
        },
    )
    .unwrap()
}

fn args(entity: Option<&str>, text: &str) -> InsertFactArgs {
    InsertFactArgs {
        input: NewFactInput {
            fact: Some(text.into()),
            source: Some("test".into()),
            entity_slug: entity.map(Into::into),
            ..NewFactInput::default()
        },
        source_id: "default".into(),
        supersede_id: None,
    }
}

fn insert(store: &Store, entity: Option<&str>, text: &str) -> u64 {
    store.insert_fact(&args(entity, text)).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn order(store: &Store, entity: &str) -> Vec<EntityFactPosition> {
    store
        .list_entity_facts_in_commit_order("default", entity, None, 10_000)
        .unwrap()
}

/// Every key the sequence family holds.
fn sequence_keys(store: &Store) -> Vec<Vec<u8>> {
    let mut prefix = keys::LEASES.to_vec();
    prefix.push(ENTITY_FACT_SEQUENCE);
    let mut found = Vec::new();
    scan_prefix(
        &*store.kv.snapshot().unwrap(),
        &prefix,
        false,
        &mut |k, _| {
            found.push(k.to_vec());
            true
        },
    )
    .unwrap();
    found
}

/// C10: many threads append to one entity (and others to a second entity at the same time). No fact is lost, the
/// numbers are 1..N with no gap and no duplicate, and the second entity has its own 1..M.
#[test]
fn c10_concurrent_appends_to_one_entity_get_one_gapless_order() {
    for (mode, kv) in kvs() {
        let store = Arc::new(open(kv, true));
        let start = Arc::new(Barrier::new(THREADS * 2));
        let handles: Vec<_> = (0..THREADS * 2)
            .map(|t| {
                let (store, start) = (store.clone(), start.clone());
                std::thread::spawn(move || {
                    let entity = if t % 2 == 0 {
                        "people/hot"
                    } else {
                        "people/other"
                    };
                    start.wait();
                    (0..PER_THREAD)
                        .map(|i| {
                            (
                                entity,
                                insert(&store, Some(entity), &format!("fact {t}-{i}")),
                            )
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut written: Vec<(&str, u64)> = Vec::new();
        for h in handles {
            written.extend(h.join().unwrap());
        }
        for entity in ["people/hot", "people/other"] {
            let ids: BTreeSet<u64> = written
                .iter()
                .filter(|(e, _)| *e == entity)
                .map(|(_, id)| *id)
                .collect();
            let rows = order(&store, entity);
            let n = THREADS * PER_THREAD;
            assert_eq!(ids.len(), n, "{mode} {entity}");
            assert_eq!(
                rows.iter().map(|r| r.sequence).collect::<Vec<_>>(),
                (1..=n as u64).collect::<Vec<_>>(),
                "{mode} {entity}: sequences 1..N with no gap or duplicate"
            );
            assert_eq!(
                rows.iter().map(|r| r.fact_id).collect::<BTreeSet<_>>(),
                ids,
                "{mode} {entity}: no lost fact"
            );
        }
    }
}

/// C11: the number an append gets is its commit order. Each commit's own commit sequence is recorded; sorted by it,
/// the numbers must run 1..N. The transactions use the stamp directly on the store's `Kv` so the commit sequence
/// (which `Store::write` does not return) is visible.
#[test]
fn c11_sequence_order_equals_commit_order() {
    for (mode, kv) in kvs() {
        let store = Arc::new(open(kv.clone(), true));
        let start = Arc::new(Barrier::new(THREADS));
        let log: Arc<Mutex<Vec<(u64, u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
        let next_id = Arc::new(AtomicU64::new(1));
        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let (kv, start, log, next_id) =
                    (kv.clone(), start.clone(), log.clone(), next_id.clone());
                std::thread::spawn(move || {
                    start.wait();
                    for _ in 0..PER_THREAD {
                        let id = next_id.fetch_add(1, Ordering::SeqCst);
                        let row = FactRecord {
                            id,
                            source_id: "default".into(),
                            entity_slug: Some("people/hot".into()),
                            ..FactRecord::default()
                        };
                        loop {
                            let mut tx = kv.begin_write().unwrap();
                            let sequence = stamp_new_row(&mut *tx, &row).unwrap().unwrap();
                            match tx.commit() {
                                Ok(commit) => {
                                    log.lock().unwrap().push((commit, sequence, id));
                                    break;
                                }
                                Err(e) if e.code == WRITE_CONFLICT => continue,
                                Err(e) => panic!("{e}"),
                            }
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let mut log = log.lock().unwrap().clone();
        let n = (THREADS * PER_THREAD) as u64;
        log.sort();
        assert_eq!(log.len() as u64, n, "{mode}");
        let commits: BTreeSet<u64> = log.iter().map(|(c, _, _)| *c).collect();
        assert_eq!(
            commits.len() as u64,
            n,
            "{mode}: one commit sequence per append"
        );
        assert_eq!(
            log.iter().map(|(_, s, _)| *s).collect::<Vec<_>>(),
            (1..=n).collect::<Vec<_>>(),
            "{mode}: sorted by commit, the numbers run 1..N"
        );
        // The reader shows the same order, and each number points to the id that was committed with it.
        let by_commit: Vec<u64> = log.iter().map(|(_, _, id)| *id).collect();
        let _ = &store;
        let read: Vec<u64> = kv_order(&kv).iter().map(|r| r.fact_id).collect();
        assert_eq!(read, by_commit, "{mode}");
    }
}

/// The index entries read straight from the keys, since these rows have no fact record behind them.
fn kv_order(kv: &Arc<dyn Kv>) -> Vec<EntityFactPosition> {
    let prefix = index_prefix("default", "people/hot");
    let mut out = Vec::new();
    scan_prefix(&*kv.snapshot().unwrap(), &prefix, false, &mut |k, v| {
        out.push(EntityFactPosition {
            sequence: keys::be8(&k[k.len() - 8..]).unwrap(),
            fact_id: keys::be8(v).unwrap(),
        });
        true
    })
    .unwrap();
    out
}

#[test]
fn off_mode_writes_nothing_under_the_sequence_family_and_reads_nothing() {
    for (mode, kv) in kvs() {
        let store = open(kv, false);
        insert(&store, Some("people/a"), "one");
        insert(&store, Some("people/a"), "two");
        store
            .insert_facts(&InsertFactsArgs {
                rows: vec![args(Some("people/a"), "three").input],
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        assert!(sequence_keys(&store).is_empty(), "{mode}");
        assert!(order(&store, "people/a").is_empty(), "{mode}");
    }
}

/// An existing fact read returns the same JSON, in the same order, with the mode on and off.
#[test]
fn existing_fact_reads_are_identical_with_the_mode_on_and_off() {
    for (mode, _) in kvs() {
        let kv_for = |on: bool| -> Arc<dyn Kv> {
            let _ = on;
            if mode == "single" {
                mem_kv()
            } else {
                Arc::new(occ_kv())
            }
        };
        let (off, on) = (open(kv_for(false), false), open(kv_for(true), true));
        for store in [&off, &on] {
            for i in 0..5 {
                insert(store, Some("people/a"), &format!("fact {i}"));
                insert(store, Some("people/b"), &format!("other {i}"));
                insert(store, None, &format!("loose {i}"));
            }
            store
                .insert_facts(&InsertFactsArgs {
                    rows: vec![args(Some("people/a"), "batch").input],
                    source_id: "default".into(),
                    delete_for_page_first: None,
                })
                .unwrap();
        }
        let q = |entity: &str| -> crate::facts::FactQuery {
            serde_json::from_value(
                json!({ "sourceId": "default", "entitySlug": entity, "limit": 100 }),
            )
            .unwrap()
        };
        for entity in ["people/a", "people/b"] {
            assert_eq!(
                off.list_facts_by_entity(&q(entity)).unwrap(),
                on.list_facts_by_entity(&q(entity)).unwrap(),
                "{mode} {entity}"
            );
        }
        // The only difference between the two stores is the sequence family.
        assert!(sequence_keys(&off).is_empty());
        assert!(!sequence_keys(&on).is_empty());
        assert_eq!(order(&on, "people/a").len(), 6, "{mode}");
        assert_eq!(order(&on, "people/b").len(), 5, "{mode}");
    }
}

#[test]
fn facts_without_an_entity_are_not_sequenced_and_a_batch_numbers_in_row_order() {
    for (mode, kv) in kvs() {
        let store = open(kv, true);
        insert(&store, None, "loose");
        assert!(sequence_keys(&store).is_empty(), "{mode}");
        let result = store
            .insert_facts(&InsertFactsArgs {
                rows: vec![
                    args(Some("people/a"), "first").input,
                    args(None, "loose").input,
                    args(Some("people/a"), "second").input,
                ],
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        let ids: Vec<u64> = result["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        let rows = order(&store, "people/a");
        assert_eq!(
            rows,
            vec![
                EntityFactPosition {
                    sequence: 1,
                    fact_id: ids[0]
                },
                EntityFactPosition {
                    sequence: 2,
                    fact_id: ids[2]
                },
            ],
            "{mode}"
        );
    }
}

#[test]
fn a_rolled_back_write_gives_its_number_back_and_a_deleted_fact_is_skipped_without_reusing_its_number()
 {
    for (mode, kv) in kvs() {
        let store = open(kv, true);
        let a = insert(&store, Some("people/a"), "a");
        let failed = store.write(|tx| -> Result<()> {
            let row = FactRecord {
                id: 999,
                source_id: "default".into(),
                entity_slug: Some("people/a".into()),
                ..FactRecord::default()
            };
            assert_eq!(stamp_new_row(tx, &row)?, Some(2));
            Err(StoreError::invalid("rolled back"))
        });
        assert!(failed.is_err(), "{mode}");
        let b = insert(&store, Some("people/a"), "b");
        let c = insert(&store, Some("people/a"), "c");
        assert_eq!(
            order(&store, "people/a"),
            vec![
                EntityFactPosition {
                    sequence: 1,
                    fact_id: a
                },
                EntityFactPosition {
                    sequence: 2,
                    fact_id: b
                },
                EntityFactPosition {
                    sequence: 3,
                    fact_id: c
                },
            ],
            "{mode}"
        );
        // Delete `b` the way a page delete does: the reader skips it, and the next number is not 3 again.
        store
            .write(|tx| crate::facts::remove_fact(tx, &Default::default(), b, true))
            .unwrap();
        let d = insert(&store, Some("people/a"), "d");
        assert_eq!(
            order(&store, "people/a"),
            vec![
                EntityFactPosition {
                    sequence: 1,
                    fact_id: a
                },
                EntityFactPosition {
                    sequence: 3,
                    fact_id: c
                },
                EntityFactPosition {
                    sequence: 4,
                    fact_id: d
                },
            ],
            "{mode}"
        );
        // Paging: after a number, with a limit; deleted entries do not use up the limit.
        let page = store
            .list_entity_facts_in_commit_order("default", "people/a", Some(1), 1)
            .unwrap();
        assert_eq!(
            page,
            vec![EntityFactPosition {
                sequence: 3,
                fact_id: c
            }],
            "{mode}"
        );
        let rest = store
            .list_entity_facts_in_commit_order("default", "people/a", Some(3), 10)
            .unwrap();
        assert_eq!(
            rest,
            vec![EntityFactPosition {
                sequence: 4,
                fact_id: d
            }],
            "{mode}"
        );
        assert!(
            store
                .list_entity_facts_in_commit_order("default", "people/a", Some(u64::MAX), 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_entity_facts_in_commit_order("default", "people/a", None, 0)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_entity_facts_in_commit_order("default", "people/none", None, 10)
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn page_replacement_and_the_ontology_insert_stamp_too() {
    for (mode, kv) in kvs() {
        let store = open(kv, true);
        let mut input = args(Some("people/a"), "from a page").input;
        input.source_markdown_slug = Some("meetings/x".into());
        let replace = |text: &str| InsertFactsArgs {
            rows: vec![NewFactInput {
                fact: Some(text.into()),
                ..input.clone()
            }],
            source_id: "default".into(),
            delete_for_page_first: Some(PageDeleteArgs {
                slug: "meetings/x".into(),
                source_id: "default".into(),
                ..PageDeleteArgs::default()
            }),
        };
        let first = store.insert_facts(&replace("one")).unwrap()["ids"][0]
            .as_u64()
            .unwrap();
        let second = store.insert_facts(&replace("two")).unwrap()["ids"][0]
            .as_u64()
            .unwrap();
        // The replaced row is gone from the order; the new one has the next number.
        assert_eq!(
            order(&store, "people/a"),
            vec![EntityFactPosition {
                sequence: 2,
                fact_id: second
            }],
            "{mode} {first}"
        );
        let obs = crate::ontology::OntologyObservation {
            source_id: "default".into(),
            entity_slug: "people/a".into(),
            dimension: "role".into(),
            value: "founder".into(),
            value_hash: "h1".into(),
            fact: "role: founder".into(),
            confidence: 1.0,
            status: "active".into(),
            visibility: "world".into(),
            source: "cli:test".into(),
            ..Default::default()
        };
        let merged = store.merge_ontology_fact(&obs).unwrap();
        let id = merged["factId"].as_u64().unwrap();
        let rows = order(&store, "people/a");
        assert_eq!(
            rows.last(),
            Some(&EntityFactPosition {
                sequence: 3,
                fact_id: id
            }),
            "{mode}"
        );
    }
}
