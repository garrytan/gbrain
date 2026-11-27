use super::*;
use crate::env::SystemEnv;
use crate::kv::Kv;
use crate::pages::{PageInput, PutPageOptions};
use crate::test_support::{mem_kv, store};
use crate::{FORMAT_VERSION, FORMAT_VERSIONS, OpenOptions, StoredFormat};
use std::sync::Arc;

fn put(store: &Store, slug: &str, body: &str) -> Value {
    let input = PageInput {
        page_type: "meeting".into(),
        title: slug.into(),
        compiled_truth: body.into(),
        ..PageInput::default()
    };
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    let hash = read_page(&*store.read().unwrap(), "default", slug)
        .unwrap()
        .unwrap()
        .content_hash
        .unwrap();
    store
        .read_atom_page_identity("default", slug, &hash)
        .unwrap()
}

fn pin(identity: &Value, slug: &str, hash: &str) -> AtomPagePin {
    AtomPagePin {
        page_id: identity["id"].as_i64().unwrap(),
        source_incarnation: identity["incarnation"].as_str().unwrap().into(),
        source_id: "default".into(),
        slug: slug.into(),
        content_hash: hash.into(),
        revision: identity["knowledge_revision"].as_str().unwrap().into(),
    }
}

fn hash_of(store: &Store, slug: &str) -> String {
    read_page(&*store.read().unwrap(), "default", slug)
        .unwrap()
        .unwrap()
        .content_hash
        .unwrap()
}

#[test]
fn a_page_row_counts_failures_tombstones_and_refuses_a_changed_page() {
    let store = store();
    let id = put(&store, "meetings/m", "Body one.");
    let hash = hash_of(&store, "meetings/m");
    let p = pin(&id, "meetings/m", &hash);
    assert_eq!(store.write_atom_page_state(&p, 1, false).unwrap(), json!(1));
    assert_eq!(store.write_atom_page_state(&p, 1, false).unwrap(), json!(2));
    assert_eq!(store.write_atom_page_state(&p, 0, true).unwrap(), json!(2));
    let row = page_state(
        &*store.read().unwrap(),
        &p.source_incarnation,
        p.page_id as u64,
        &hash,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        (row.fail_count, row.tombstoned, row.partial_input_chars),
        (2, true, None)
    );
    // A stale revision, slug or hash pins nothing.
    let mut stale = p.clone();
    stale.revision = "00000000-0000-4000-8000-000000000000".into();
    assert_eq!(
        store.write_atom_page_state(&stale, 1, false).unwrap(),
        Value::Null
    );
    let mut other = p.clone();
    other.slug = "meetings/other".into();
    assert_eq!(
        store.record_atom_page_partial(&other, 10).unwrap(),
        Value::Null
    );
    let mut bad = p.clone();
    bad.source_incarnation = "not-a-uuid".into();
    assert!(
        store
            .write_atom_page_state(&bad, 1, false)
            .unwrap_err()
            .to_string()
            .contains("invalid input syntax for type uuid")
    );
}

#[test]
fn a_page_row_goes_with_a_soft_delete_a_hard_delete_and_another_contents_bump() {
    let store = store();
    let id = put(&store, "meetings/m", "Body one.");
    let hash = hash_of(&store, "meetings/m");
    let p = pin(&id, "meetings/m", &hash);
    store.write_atom_page_state(&p, 1, false).unwrap();
    let rows = |store: &Store| {
        page_rows(&*store.read().unwrap(), p.page_id as u64)
            .unwrap()
            .len()
    };
    assert_eq!(rows(&store), 1);
    // A bump that keeps this content keeps the row; one that keeps another drops it.
    store
        .write(|tx| {
            drop_other_contents(
                tx,
                &p.source_incarnation.to_uppercase(),
                p.page_id as u64,
                Some(&hash),
            )
        })
        .unwrap();
    assert_eq!(rows(&store), 1);
    store
        .write(|tx| drop_other_contents(tx, &p.source_incarnation, p.page_id as u64, None))
        .unwrap();
    assert_eq!(rows(&store), 0);
    store.write_atom_page_state(&p, 1, false).unwrap();
    store
        .soft_delete_page("meetings/m", Some("default"))
        .unwrap();
    assert_eq!(rows(&store), 0);
}

#[test]
fn transcript_rows_strike_tombstone_partial_and_release_below_the_cap() {
    let store = store();
    assert_eq!(
        store.strike_transcript("default", "/a.txt", "h1").unwrap(),
        1
    );
    assert_eq!(
        store.strike_transcript("default", "/a.txt", "h1").unwrap(),
        2
    );
    store
        .stamp_transcript_tombstone("default", "/b.txt", "h2")
        .unwrap();
    store
        .record_transcript_partial("default", "/c.txt", "h3", 500)
        .unwrap();
    store
        .record_transcript_partial("default", "/d.txt", "h4", 2000)
        .unwrap();
    let listed = |store: &Store| {
        store
            .list_tombstoned_transcripts(
                "default",
                &["h1".into(), "h2".into(), "h3".into(), "h4".into()],
            )
            .unwrap()
    };
    assert_eq!(
        listed(&store),
        vec![
            json!({ "file_path": "/b.txt", "content_hash": "h2" }),
            json!({ "file_path": "/c.txt", "content_hash": "h3" }),
            json!({ "file_path": "/d.txt", "content_hash": "h4" }),
        ]
    );
    store
        .release_partial_atom_dispositions("default", 1000)
        .unwrap();
    assert_eq!(
        listed(&store),
        vec![
            json!({ "file_path": "/b.txt", "content_hash": "h2" }),
            json!({ "file_path": "/d.txt", "content_hash": "h4" }),
        ]
    );
    assert!(
        store
            .list_tombstoned_transcripts("other", &["h2".into()])
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .strike_transcript("default", "/n\0ul", "h")
            .unwrap_err()
            .to_string()
            .contains("0x00")
    );
}

fn dump(kv: &Arc<dyn Kv>) -> Vec<(Vec<u8>, Vec<u8>)> {
    let snap = kv.snapshot().unwrap();
    let mut out = Vec::new();
    scan_prefix(&*snap, &[], false, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    out
}

/// A format-8 brain opens at this format with nothing rewritten but the format stamp.
#[test]
fn a_format_8_brain_opens_at_this_format_and_writes_no_ledger_row() {
    let kv = mem_kv();
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    put(&store, "meetings/m", "Body one.");
    store
        .write(|w| {
            let mut stored: StoredFormat = get_json(&*w, &keys::meta("format"))?.unwrap();
            stored.format_version = 8;
            put_json(w, &keys::meta("format"), &stored)
        })
        .unwrap();
    drop(store);
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    assert_eq!(store.info().format_version, FORMAT_VERSION);
    let mut prefix = keys::ATOM_EXTRACTION_STATE.to_vec();
    prefix.push(PAGE_ROW);
    assert!(all_page_rows(&*store.read().unwrap()).unwrap().is_empty());
}

/// A build that stops at format 16 (the formats before this one, ending at 16) refuses a brain this build wrote, before
/// it changes anything.
#[test]
fn a_format_16_build_refuses_a_format_17_store() {
    assert_eq!(
        FORMAT_VERSION, 17,
        "this case pins store format 17 (the trunk's allotment)"
    );
    let kv = mem_kv();
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    let id = put(&store, "meetings/m", "Body one.");
    let hash = hash_of(&store, "meetings/m");
    store
        .write_atom_page_state(&pin(&id, "meetings/m", &hash), 1, false)
        .unwrap();
    drop(store);
    let before = dump(&kv);
    let older: Vec<u32> = FORMAT_VERSIONS[..FORMAT_VERSIONS.len() - 1]
        .iter()
        .copied()
        .chain([16])
        .collect();
    let err = Store::open_kv_in(
        kv.clone(),
        Arc::new(SystemEnv),
        OpenOptions::default(),
        &older,
    )
    .err()
    .unwrap();
    assert_eq!(err.code, crate::error::FORMAT_UNKNOWN);
    assert!(
        err.to_string()
            .contains("store format 17, newer than the formats this build opens"),
        "{err}"
    );
    assert_eq!(dump(&kv), before, "the refused brain is unchanged");
}
