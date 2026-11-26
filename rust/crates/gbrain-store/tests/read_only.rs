//! The read-only open: a brain opened only to read leaves every byte of its record file as it
//! was, and refuses each write it would need instead of making it.

mod common;

use common::TempDir;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::{READ_ONLY_TRANSACTION, STORE_IO, STORE_LOCKED};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::search::SearchOptions;
use gbrain_store::{OpenOptions, Store};
use serde_json::json;
use std::path::{Path, PathBuf};

/// A closed brain of 50 pages, every one with a sealed chunk that holds "apple".
fn closed_brain(dir: &TempDir) -> PathBuf {
    let brain = dir.path().join("brain");
    let store = Store::open_dir(&brain, OpenOptions::default()).unwrap();
    for i in 0..50 {
        let slug = format!("notes/page-{i}");
        let body = format!("apple pie number {i}");
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": format!("Page {i}"), "compiled_truth": body,
        }))
        .unwrap();
        let options: PutPageOptions = serde_json::from_value(json!({"index": false})).unwrap();
        store.put_page(&slug, &input, &options).unwrap();
        let chunk: ChunkInput = serde_json::from_value(json!({
            "chunk_index": 0, "chunk_text": body, "chunk_source": "compiled_truth",
        }))
        .unwrap();
        let seal = UpsertChunksOptions {
            seal: true,
            ..UpsertChunksOptions::default()
        };
        store.upsert_chunks(&slug, &[chunk], &seal).unwrap();
    }
    let state = store.keyword_index_state().unwrap().unwrap();
    assert!(
        state.complete,
        "the test brain's keyword index must be complete"
    );
    store.close();
    brain
}

fn bytes(brain: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        std::fs::read(brain.join("records.redb")).unwrap(),
        std::fs::read(brain.join("FORMAT")).unwrap(),
    )
}

fn open_to_read(brain: &Path) -> Store {
    Store::open_dir_read_only(brain).unwrap()
}

#[test]
fn reading_a_closed_brain_leaves_its_record_file_byte_for_byte_unchanged() {
    let dir = TempDir::new("ro-bytes");
    let brain = closed_brain(&dir);
    let before = bytes(&brain);
    let store = open_to_read(&brain);
    let hits = store
        .search_keyword("apple", &SearchOptions::default())
        .unwrap();
    assert!(!hits.is_empty());
    let report = store.keyword_index_verify(None).unwrap();
    assert!(report.ok);
    store.close();
    let after = bytes(&brain);
    let differ = before
        .0
        .iter()
        .zip(&after.0)
        .filter(|(a, b)| a != b)
        .count();
    assert!(
        before == after,
        "records.redb changed: {differ} bytes differ, lengths {} and {}",
        before.0.len(),
        after.0.len()
    );
}

#[test]
fn a_write_through_a_read_only_brain_is_refused_and_changes_nothing() {
    let dir = TempDir::new("ro-write");
    let brain = closed_brain(&dir);
    let before = bytes(&brain);
    let store = open_to_read(&brain);
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": "New", "compiled_truth": "x"}))
            .unwrap();
    let error = store
        .put_page("notes/new", &input, &PutPageOptions::default())
        .expect_err("a read-only brain must refuse a write");
    assert_eq!(error.code, READ_ONLY_TRANSACTION, "{error}");
    store.close();
    assert!(
        before == bytes(&brain),
        "the refused write changed the files"
    );
    // The brain still opens for writing, and the refused page is not there.
    let store = Store::open_dir(&brain, OpenOptions::default()).unwrap();
    assert!(
        store
            .read_page_snapshot("notes/new", &ReadScope::default())
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_directory_with_no_brain_is_refused_and_left_empty() {
    let dir = TempDir::new("ro-none");
    let brain = dir.path().join("brain");
    std::fs::create_dir_all(&brain).unwrap();
    let error = Store::open_dir_read_only(&brain)
        .err()
        .expect("no brain to read");
    assert_eq!(error.code, STORE_IO, "{error}");
    assert_eq!(std::fs::read_dir(&brain).unwrap().count(), 0);
    let missing = dir.path().join("missing");
    assert!(Store::open_dir_read_only(&missing).is_err());
    assert!(
        !missing.exists(),
        "a read-only open must not create the directory"
    );
}

#[test]
fn embedded_one_owner_a_read_only_open_of_a_brain_open_for_writing_is_refused() {
    let dir = TempDir::new("ro-locked");
    let brain = closed_brain(&dir);
    let writer = Store::open_dir(&brain, OpenOptions::default()).unwrap();
    let error = Store::open_dir_read_only(&brain)
        .err()
        .expect("the writer holds the brain");
    assert_eq!(error.code, STORE_LOCKED, "{error}");
    assert!(writer.commit_version().is_ok());
}

/// C17: with several writers a read-only open beside a writer is served (the reader is a client), not refused with
/// `store_locked`. Twin of `embedded_one_owner_a_read_only_open_of_a_brain_open_for_writing_is_refused`; pending on the
/// server lane.
#[test]
#[ignore = "multi_writer"]
fn a_read_only_open_beside_a_writer_is_served_multi_writer() {
    common::mu::pending_member::<()>(
        common::mu::L3_SERVER,
        "a reader beside a writer becomes a client",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let dir = TempDir::new("ro-multi");
    let brain = closed_brain(&dir);
    let writer = Store::open_dir(&brain, OpenOptions::default()).unwrap();
    let reader =
        Store::open_dir_read_only(&brain).unwrap_or_else(|e| panic!("the reader was refused: {e}"));
    assert!(writer.commit_version().is_ok() && reader.commit_version().is_ok());
}
