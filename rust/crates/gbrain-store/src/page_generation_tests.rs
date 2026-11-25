//! The page generation counter across a store format upgrade and an older build (rust/docs/store/format.md,
//! rust/docs/store/question-reads.md): every page of a brain upgraded from an earlier format gets a generation and an
//! index row in the upgrade's one transaction, a failure part-way leaves the old format untouched, and a build that
//! knows only the earlier formats refuses the brain.
//!
//! The key layout is the contract these tests read: `M page_generation/<generation BE8><page id BE8>`, empty value.

use crate::error::{FORMAT_UNKNOWN, STORE_CORRUPT, STORE_IO};
use crate::kv::{Kv, scan_prefix};
use crate::pages::{PageInput, PutPageOptions};
use crate::test_support::{FaultOp, FaultyKv, mem_kv};
use crate::{FORMAT_VERSION, FORMAT_VERSIONS, OpenOptions, Store, SystemEnv, format, keys};
use serde_json::{Value, json};
use std::sync::Arc;

const INDEX: &[u8] = b"Mpage_generation/";

/// The formats the build before this one opened.
fn previous_formats() -> &'static [u32] {
    &FORMAT_VERSIONS[..FORMAT_VERSIONS.len() - 1]
}

fn open(kv: &Arc<dyn Kv>) -> crate::Result<Store> {
    Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default())
}

fn dump(kv: &Arc<dyn Kv>) -> Vec<(Vec<u8>, Vec<u8>)> {
    let snapshot = kv.snapshot().unwrap();
    let mut out = Vec::new();
    scan_prefix(&*snapshot, &[], false, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    out
}

/// The index rows, as (generation, page id), in key order; every value must be empty.
fn index_rows(kv: &Arc<dyn Kv>) -> Vec<(u64, u64)> {
    dump(kv)
        .into_iter()
        .filter(|(k, _)| k.starts_with(INDEX))
        .map(|(k, v)| {
            assert!(v.is_empty(), "an index row holds no value");
            let tail = &k[INDEX.len()..];
            assert_eq!(
                tail.len(),
                16,
                "an index row key ends in two 8-byte numbers"
            );
            (
                keys::be8(&tail[..8]).unwrap(),
                keys::be8(&tail[8..]).unwrap(),
            )
        })
        .collect()
}

/// Every page record as JSON, by page id.
fn pages(kv: &Arc<dyn Kv>) -> Vec<Value> {
    let mut out: Vec<Value> = dump(kv)
        .into_iter()
        .filter(|(k, _)| k.first() == Some(&keys::PAGE))
        .map(|(_, v)| serde_json::from_slice(&v).unwrap())
        .collect();
    out.sort_by_key(|p| p["id"].as_u64().unwrap());
    out
}

fn stored_format(kv: &Arc<dyn Kv>) -> u32 {
    let bytes = kv
        .snapshot()
        .unwrap()
        .get(&keys::meta("format"))
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    u32::try_from(value["format_version"].as_u64().unwrap()).unwrap()
}

/// Three pages (the second soft-deleted), then the brain as an older build left it: the format record at `version`, no
/// generation on any page and no index row.
fn old_brain(version: u32) -> Arc<dyn Kv> {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    for (slug, body) in [("notes/a", "one"), ("notes/b", "two"), ("notes/c", "three")] {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": body}))
                .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    }
    store.soft_delete_page("notes/b", None).unwrap();
    drop(store);
    let mut tx = kv.begin_write().unwrap();
    for (key, value) in dump(&kv) {
        if key.starts_with(INDEX) {
            tx.delete(&key).unwrap();
        } else if key.first() == Some(&keys::PAGE) {
            let mut page: Value = serde_json::from_slice(&value).unwrap();
            page.as_object_mut().unwrap().remove("generation");
            tx.put(&key, &serde_json::to_vec(&page).unwrap()).unwrap();
        }
    }
    let mut format: Value =
        serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
    format["format_version"] = json!(version);
    tx.put(&keys::meta("format"), &serde_json::to_vec(&format).unwrap())
        .unwrap();
    tx.commit().unwrap();
    kv
}

#[test]
fn a_brain_from_every_earlier_format_upgrades_with_one_generation_per_page_by_id() {
    for &version in previous_formats() {
        let kv = old_brain(version);
        assert_eq!(
            index_rows(&kv),
            vec![],
            "format {version} starts with no rows"
        );
        let store = open(&kv).unwrap_or_else(|e| panic!("format {version}: {e:?}"));
        assert_eq!(
            store.info().format_version,
            FORMAT_VERSION,
            "format {version}"
        );
        drop(store);
        let ids: Vec<u64> = pages(&kv)
            .iter()
            .map(|p| p["id"].as_u64().unwrap())
            .collect();
        let generations: Vec<u64> = pages(&kv)
            .iter()
            .map(|p| p["generation"].as_u64().unwrap())
            .collect();
        // No primary to copy from: the pages, soft-deleted ones included, number 1..n in id order.
        assert_eq!(generations, vec![1, 2, 3], "format {version}");
        assert_eq!(
            index_rows(&kv),
            ids.iter()
                .enumerate()
                .map(|(i, id)| (i as u64 + 1, *id))
                .collect::<Vec<_>>(),
            "format {version}"
        );
        assert_eq!(stored_format(&kv), FORMAT_VERSION);
        // Opening again changes nothing.
        let after = dump(&kv);
        drop(open(&kv).unwrap());
        assert_eq!(dump(&kv), after, "format {version}");
    }
}

#[test]
fn the_page_after_an_upgraded_brain_takes_the_highest_generation_plus_one() {
    let kv = old_brain(previous_formats()[previous_formats().len() - 1]);
    let store = open(&kv).unwrap();
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": "d", "compiled_truth": "four"}))
            .unwrap();
    let page = store
        .put_page("notes/d", &input, &PutPageOptions::default())
        .unwrap();
    let id = page["id"].as_u64().unwrap();
    drop(store);
    assert_eq!(index_rows(&kv).last(), Some(&(4, id)));
}

#[test]
fn an_upgrade_that_fails_part_way_leaves_the_old_brain_and_the_next_open_finishes_it() {
    for code in [STORE_IO, STORE_CORRUPT] {
        let inner = old_brain(*previous_formats().last().unwrap());
        let before = dump(&inner);
        let failing: Arc<dyn Kv> = Arc::new(FaultyKv {
            inner: inner.clone(),
            code,
            ops: &[FaultOp::Put],
            // The index rows come last in the upgrade, after every page record has its generation.
            fail_on: |key| key.starts_with(INDEX),
        });
        let err = open(&failing).err().expect("the open must fail");
        assert_eq!(err.code, code, "{}", err.message);
        assert_eq!(
            dump(&inner),
            before,
            "{code}: a failed upgrade changed the brain"
        );
        assert_eq!(stored_format(&inner), *previous_formats().last().unwrap());
        // The brain is whole: the next open upgrades it.
        drop(open(&inner).unwrap());
        assert_eq!(stored_format(&inner), FORMAT_VERSION);
        assert_eq!(index_rows(&inner).len(), 3);
    }
}

#[test]
fn an_upgrade_that_fails_on_a_page_record_leaves_the_old_brain_too() {
    let inner = old_brain(*previous_formats().last().unwrap());
    let before = dump(&inner);
    let failing: Arc<dyn Kv> = Arc::new(FaultyKv {
        inner: inner.clone(),
        code: STORE_IO,
        ops: &[FaultOp::Put],
        fail_on: |key| key.first() == Some(&keys::PAGE),
    });
    let err = open(&failing).err().expect("the open must fail");
    assert_eq!(err.code, STORE_IO, "{}", err.message);
    assert_eq!(dump(&inner), before);
}

#[test]
fn a_brain_with_no_pages_upgrades_to_no_index_rows() {
    let kv = mem_kv();
    drop(open(&kv).unwrap());
    let mut tx = kv.begin_write().unwrap();
    let mut format: Value =
        serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
    format["format_version"] = json!(*previous_formats().last().unwrap());
    tx.put(&keys::meta("format"), &serde_json::to_vec(&format).unwrap())
        .unwrap();
    tx.commit().unwrap();
    drop(open(&kv).unwrap());
    assert_eq!(stored_format(&kv), FORMAT_VERSION);
    assert_eq!(index_rows(&kv), vec![]);
}

#[test]
fn a_build_that_knows_only_the_earlier_formats_refuses_this_one_and_changes_nothing() {
    let kv = mem_kv();
    drop(open(&kv).unwrap());
    assert_eq!(stored_format(&kv), FORMAT_VERSION);
    let before = dump(&kv);
    let older = previous_formats();
    let err = format::check_version_in(FORMAT_VERSION, older).unwrap_err();
    assert_eq!(err.code, FORMAT_UNKNOWN);
    assert!(err.message.contains("newer"), "{}", err.message);
    let err = Store::open_kv_in(
        kv.clone(),
        Arc::new(SystemEnv),
        OpenOptions::default(),
        older,
    )
    .err()
    .expect("an older build must refuse a newer brain");
    assert_eq!(err.code, FORMAT_UNKNOWN, "{}", err.message);
    assert_eq!(dump(&kv), before);
}
