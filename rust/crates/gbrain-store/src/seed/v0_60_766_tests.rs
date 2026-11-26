//! A shadow store written by the v0.60.766.0 Rust addon, opened by this build.
//!
//! `tests/fixtures/shadow_seed_v0_60_766/store.json` is every record of a store that the
//! v0.60.766.0 store crate (origin/master `rust/crates/gbrain-store`, byte-identical to the
//! release commit ae4bef02ce) wrote when `generate.rs` fed it `rows.json` through
//! `import_relation_with_digests`, the call `gbrain engine shadow seed` makes. Its format record
//! says 5, the format this build also had before it learned the older records.
//!
//! Each test loads those records into an empty record file, opens it with this build, and checks
//! the reads against a store this build seeds itself from the same rows: the answers must match,
//! or the open must be refused with `shadow_reseed_required` and the re-seed steps.

use super::DigestInput;
use crate::kv::{KvRead, scan_prefix};
use crate::test_support::mem_kv;
use crate::{OpenOptions, Store, SystemEnv, keys};
use serde_json::{Value, json};
use std::sync::Arc;

const STORE: &str = include_str!("../../tests/fixtures/shadow_seed_v0_60_766/store.json");
const ROWS: &str = include_str!("../../tests/fixtures/shadow_seed_v0_60_766/rows.json");

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// The v0.60.766.0 records, with `edit` applied to them, in an empty record file.
fn old_records(edit: impl FnOnce(&mut Vec<(Vec<u8>, Vec<u8>)>)) -> Arc<dyn crate::kv::Kv> {
    let fixture: Value = serde_json::from_str(STORE).unwrap();
    let mut records: Vec<(Vec<u8>, Vec<u8>)> = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            (
                unhex(pair[0].as_str().unwrap()),
                unhex(pair[1].as_str().unwrap()),
            )
        })
        .collect();
    edit(&mut records);
    let kv = mem_kv();
    let mut tx = kv.begin_write().unwrap();
    // The record file's commit sequence (`M \0 seq`, redb_kv) is the file's own, not a record.
    for (k, v) in records.iter().filter(|(k, _)| k.as_slice() != b"M\0seq") {
        tx.put(k, v).unwrap();
    }
    tx.commit().unwrap();
    kv
}

/// The store the v0.60.766.0 seed wrote, opened by this build.
fn old_store() -> Store {
    Store::open_kv(
        old_records(|_| {}),
        Arc::new(SystemEnv),
        OpenOptions::default(),
    )
    .unwrap()
}

/// A store this build seeds from the same rows, with the same digests.
fn new_store() -> Store {
    let rows: Value = serde_json::from_str(ROWS).unwrap();
    let store = crate::test_support::store();
    let seed_id = rows["seed_id"].as_str().unwrap();
    for rel in rows["relations"].as_array().unwrap() {
        let batch: Vec<super::SeedRow> = serde_json::from_value(rel[1].clone()).unwrap();
        let digests: Vec<DigestInput> = (0..batch.len())
            .map(|i| DigestInput {
                sort: format!("{:016x}", i + 1),
                digest: format!("{:064x}", i + 1),
            })
            .collect();
        store
            .import_relation_with_digests(seed_id, rel[0].as_str().unwrap(), batch, &digests)
            .unwrap();
    }
    store
}

/// Every record under `prefix`.
fn records(store: &Store, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let read = store.read().unwrap();
    let mut out = Vec::new();
    scan_prefix(&*read, prefix, false, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    out
}

#[test]
fn page_purge_tombstones_the_old_seed_wrote_guard_count_and_update_as_this_builds_own() {
    let (old, new) = (old_store(), new_store());
    // The ledger holds the same records, key and value, as this build's seed writes.
    let ledger = [keys::FACT, 0x0C];
    assert_eq!(records(&old, &ledger), records(&new, &ledger));
    assert_eq!(records(&old, &ledger).len(), 2);
    for store in [&old, &new] {
        // The page guard refuses a page whose content hash was purged in its source.
        let read = store.read().unwrap();
        let mut page = crate::pages::read_page(&*read, "default", "people/alice-example")
            .unwrap()
            .unwrap();
        page.content_hash = Some("h1".into());
        let refused =
            crate::facts::page_purges::refuse_purged_page(&*read, None, &page).unwrap_err();
        assert!(
            refused.message.starts_with("purged_content:"),
            "{}",
            refused.message
        );
        drop(read);
        // A purge of the same hash replaces the tombstone instead of adding a second one.
        store
            .record_page_purge("default", &["h1".to_string()], "late", None)
            .unwrap();
        assert_eq!(
            store
                .count_page_purge_tombstones("default", "late")
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .count_page_purge_tombstones("default", "early")
                .unwrap(),
            0
        );
        assert_eq!(records(store, &ledger).len(), 2);
    }
}

#[test]
fn generations_the_old_seed_wrote_list_their_unwithdrawn_facts() {
    let (old, new) = (old_store(), new_store());
    let args =
        serde_json::from_value(json!({ "sourceIds": ["default"], "fenceKind": "fence" })).unwrap();
    let listed = new.list_unwithdrawn_facts(&args).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["generation_id"], json!(301));
    assert_eq!(old.list_unwithdrawn_facts(&args).unwrap(), listed);
    // The ledger holds the same records as this build's seed writes, and none at the old key.
    let ledger = [keys::DERIVED_GENERATION];
    assert_eq!(records(&old, &ledger), records(&new, &ledger));
    assert!(records(&old, &[keys::FACT, 0x0E]).is_empty());
    assert_eq!(
        records(&old, &keys::meta("next_derived_generation_id")),
        records(&new, &keys::meta("next_derived_generation_id"))
    );
}

#[test]
fn oauth_clients_the_old_seed_wrote_read_as_this_builds_seed_stores_them() {
    let (old, new) = (old_store(), new_store());
    for id in ["c-agent", "c-bound", "c-gone", "c-plain"] {
        let row = new.read_oauth_client(id).unwrap();
        assert!(row.is_some(), "{id}");
        assert_eq!(old.read_oauth_client(id).unwrap(), row, "{id}");
    }
    assert_eq!(
        old.read_client_budget_usd("c-agent").unwrap().as_deref(),
        Some("5.00")
    );
    assert_eq!(
        old.read_agent_client_spend().unwrap(),
        new.read_agent_client_spend().unwrap()
    );
}

#[test]
fn an_old_store_opens_on_the_new_format_and_says_so() {
    let old = old_store();
    assert_eq!(old.info().format_version, crate::format::FORMAT_VERSION);
    const { assert!(crate::format::FORMAT_VERSION > 5) };
    let read = old.read().unwrap();
    let stored: Value = crate::get_json(&*read, &keys::meta("format"))
        .unwrap()
        .unwrap();
    assert_eq!(
        stored["format_version"],
        json!(crate::format::FORMAT_VERSION)
    );
}

#[test]
fn an_old_record_this_build_cannot_carry_refuses_the_open_with_the_reseed_steps() {
    // A generation record from the old seed that names a source the store does not hold.
    let kv = old_records(|records| {
        for (k, v) in records.iter_mut() {
            if k.starts_with(&[keys::FACT, 0x0E]) {
                let mut g: Value = serde_json::from_slice(v).unwrap();
                g["source_id"] = json!("gone");
                *v = serde_json::to_vec(&g).unwrap();
            }
        }
    });
    let before = dump(&*kv.snapshot().unwrap());
    let err = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default())
        .err()
        .expect("the open must be refused");
    assert_eq!(err.code, "shadow_reseed_required");
    assert!(err.message.contains("store format 5"), "{}", err.message);
    assert!(
        err.message.contains("gbrain engine shadow seed"),
        "{}",
        err.message
    );
    // Nothing changed.
    assert_eq!(dump(&*kv.snapshot().unwrap()), before);
}

/// The re-seed message tells a person the exact commands that re-seed and turn shadow mode on:
/// `gbrain engine shadow start` alone only prints a plan (`src/commands/engine-shadow.ts`).
#[test]
fn the_reseed_steps_end_with_the_two_step_start_that_turns_shadow_mode_on() {
    let steps = super::RESEED_STEPS;
    let plan = steps
        .find("gbrain engine shadow start --plan")
        .expect(steps);
    let on = steps
        .find("gbrain engine shadow start --yes --expect <plan_hash>")
        .expect(steps);
    let seed = steps.find("gbrain engine shadow seed").expect(steps);
    let stop = steps
        .find("gbrain engine shadow stop --delete")
        .expect(steps);
    assert!(stop < seed && seed < plan && plan < on, "{steps}");
    assert!(steps.ends_with("to turn shadow mode on again"), "{steps}");
}

#[test]
fn a_refused_open_gives_the_steps_that_turn_shadow_mode_back_on() {
    let kv = old_records(|records| {
        for (k, v) in records.iter_mut() {
            if k.starts_with(&[keys::FACT, 0x0E]) {
                let mut g: Value = serde_json::from_slice(v).unwrap();
                g["source_id"] = json!("gone");
                *v = serde_json::to_vec(&g).unwrap();
            }
        }
    });
    let err = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default())
        .err()
        .expect("the open must be refused");
    assert_eq!(err.code, "shadow_reseed_required");
    assert!(
        err.message
            .contains("gbrain engine shadow start --yes --expect <plan_hash>"),
        "{}",
        err.message
    );
}

/// Opens the v0.60.766.0 records on a record store whose write transactions fail with `code` on
/// the keys `fail_on` accepts; the open must report that error as it is, and change nothing.
fn open_old_records_on_failing_disk(code: &'static str, fail_on: fn(&[u8]) -> bool) {
    let inner = old_records(|_| {});
    let before = dump(&*inner.snapshot().unwrap());
    let kv: Arc<dyn crate::kv::Kv> = Arc::new(crate::test_support::FaultyKv {
        inner: inner.clone(),
        code,
        ops: &[
            crate::test_support::FaultOp::Scan,
            crate::test_support::FaultOp::Put,
        ],
        fail_on,
    });
    let err = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default())
        .err()
        .expect("the open must fail");
    assert_eq!(err.code, code, "{}", err.message);
    assert!(
        !err.message.contains("Re-seed") && !err.message.contains("gbrain engine shadow"),
        "an I/O or storage error must not tell the person to re-seed: {}",
        err.message
    );
    assert_eq!(dump(&*inner.snapshot().unwrap()), before);
}

#[test]
fn an_io_error_reading_the_old_records_is_reported_as_store_io_not_as_a_reseed() {
    open_old_records_on_failing_disk(crate::error::STORE_IO, |key| {
        key.starts_with(&[keys::FACT, 0x0C])
    });
}

#[test]
fn a_corrupt_record_store_while_reading_the_old_records_is_reported_as_store_corrupt() {
    open_old_records_on_failing_disk(crate::error::STORE_CORRUPT, |key| {
        key.starts_with(&[keys::FACT, 0x0C])
    });
}

#[test]
fn an_io_error_writing_a_carried_over_generation_is_reported_as_store_io_not_as_a_reseed() {
    // The generation step writes through the seed's own writers; an error from them that is not
    // about the record (the disk failed) is not a reason to re-seed.
    open_old_records_on_failing_disk(crate::error::STORE_IO, |key| {
        key.first() == Some(&keys::DERIVED_GENERATION)
    });
}

fn dump(read: &dyn KvRead) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    scan_prefix(read, &[], false, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    out
}

/// The records that differ between two stores seeded from the same rows at different times or
/// with different ids: the brain id, the clocks, the record file's own counters, and the shared
/// skill catalog's random token secret (`x 0x04`), which a fresh store writes and an older store
/// gets the first time it is read (`Store::shared_skill_token_secret`).
fn volatile(key: &[u8]) -> bool {
    [
        b"Mformat".as_slice(),
        b"Mshadow_seed",
        b"M\0seq",
        b"Ctrust.backfill_completed_at",
        b"Cwrite_gate.scan_baseline",
        &[keys::ACCESS_MEMBERS, 0x04],
    ]
    .contains(&key)
}

/// A record with the fields a fresh store draws at random or from its clock taken out: the
/// `default` source's incarnation and creation time.
fn steady(key: &[u8], value: &[u8]) -> Vec<u8> {
    if key != b"Sdefault" {
        return value.to_vec();
    }
    let mut source: Value = serde_json::from_slice(value).unwrap();
    let fields = source.as_object_mut().unwrap();
    fields.remove("incarnation");
    fields.remove("created_at_us");
    serde_json::to_vec(&source).unwrap()
}

#[test]
fn every_record_the_old_seed_wrote_matches_this_builds_seed() {
    let (old, new) = (old_store(), new_store());
    let old = dump(&*old.read().unwrap());
    let new = dump(&*new.read().unwrap());
    let keep = |records: Vec<(Vec<u8>, Vec<u8>)>| -> std::collections::BTreeMap<Vec<u8>, Vec<u8>> {
        records
            .into_iter()
            .filter(|(k, _)| !volatile(k))
            .map(|(k, v)| {
                let v = steady(&k, &v);
                (k, v)
            })
            .collect()
    };
    let (old, new) = (keep(old), keep(new));
    let differ: Vec<String> = old
        .keys()
        .chain(new.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|k| old.get(*k) != new.get(*k))
        .map(|k| {
            format!(
                "{} old={:?} new={:?}",
                String::from_utf8_lossy(k).escape_debug(),
                old.get(k).map(|v| String::from_utf8_lossy(v).into_owned()),
                new.get(k).map(|v| String::from_utf8_lossy(v).into_owned())
            )
        })
        .collect();
    assert!(
        differ.is_empty(),
        "{} records differ:\n{}",
        differ.len(),
        differ.join("\n")
    );
}
