//! `verify_store_dir`: the check of a copy before any open can change it
//! (`rust/docs/store/snapshot.md`, "Verifying a copy").

mod common;

use common::TempDir;
use gbrain_store::error::{INVALID_ARGUMENT, STORE_IO};
use gbrain_store::keys;
use gbrain_store::kv::{Kv, collect_prefix};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::seed::DigestInput;
use gbrain_store::snapshot::{MANIFEST_FILE, SnapshotManifest, SnapshotOp};
use gbrain_store::verify::{Verdict, VerifyReport, verify_store_dir};
use gbrain_store::{OpenOptions, Store};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const MARKER: &str = "zzuniquemarkerzzzzuniquemarkerzz";

fn put(store: &Store, n: u32) {
    let body = format!(
        "page {n} apple pear {MARKER} {}",
        "filler words ".repeat(20)
    );
    let page: PageInput = serde_json::from_value(serde_json::json!({
        "type": "note", "title": format!("Page {n}"), "compiled_truth": body,
    }))
    .unwrap();
    store
        .put_page(&format!("notes/p{n}"), &page, &PutPageOptions::default())
        .unwrap();
}

fn plain() -> OpenOptions {
    OpenOptions {
        keyword_index_builder: false,
        ..OpenOptions::default()
    }
}

/// A brain with `pages` pages, copied to `<dir>/copy`. With `build_steps`, the keyword index is
/// reset and built that many 7-page steps before the copy, so it is incomplete with an unbuilt tail.
fn copy_of(dir: &TempDir, pages: u32, build_steps: u32) -> (Store, PathBuf, SnapshotManifest) {
    let store = Store::open_dir(&dir.path().join("brain"), plain()).unwrap();
    for n in 0..pages {
        put(&store, n);
    }
    if build_steps > 0 {
        store.keyword_index_rebuild().unwrap();
        for _ in 0..build_steps {
            store.keyword_index_build_step(7).unwrap();
        }
    }
    let target = dir.path().join("copy");
    let manifest = store.snapshot_to(&target, &SnapshotOp::new()).unwrap();
    (store, target, manifest)
}

fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

/// Changes the copy's records the way a damaged or edited copy would differ (one commit).
fn edit(copy: &Path, change: impl FnOnce(&mut dyn gbrain_store::KvWrite)) {
    let kv = RedbKv::open_path(&copy.join("records.redb")).unwrap();
    let mut tx = kv.begin_write().unwrap();
    change(&mut *tx);
    tx.commit().unwrap();
}

fn verify(copy: &Path, expected: Option<&SnapshotManifest>) -> VerifyReport {
    verify_store_dir(copy, expected).unwrap()
}

#[test]
fn a_copy_verifies_and_verifying_it_changes_no_byte() {
    let dir = TempDir::new("verify-ok");
    let (_store, copy, manifest) = copy_of(&dir, 20, 0);
    let before = files(&copy);
    let report = verify(&copy, Some(&manifest));
    assert_eq!(report.verdict, Verdict::Ok, "{report:?}");
    assert_eq!(report.generation, Some(manifest.generation));
    assert_eq!(report.tags, manifest.tags);
    assert_eq!(report.keyword_index.as_ref().unwrap().state, "complete");
    assert_eq!(files(&copy), before, "verification wrote nothing");
    // The manifest on disk is the manifest the call returned.
    let on_disk: SnapshotManifest =
        serde_json::from_slice(&std::fs::read(copy.join(MANIFEST_FILE)).unwrap()).unwrap();
    assert_eq!(on_disk, manifest);
}

/// The reason this primitive exists: a normal open of an incomplete copy starts the keyword
/// builder, which commits. Verifying first sees the copy at the generation it was taken at.
#[test]
fn an_incomplete_index_verifies_at_its_own_generation_and_keeps_its_cursor() {
    let dir = TempDir::new("verify-incomplete");
    let (store, copy, manifest) = copy_of(&dir, 40, 2);
    let state = store.keyword_index_state().unwrap().unwrap();
    assert!(
        !state.complete && state.cursor.is_some_and(|c| c > 0),
        "{state:?}"
    );
    let before = files(&copy);
    let report = verify(&copy, Some(&manifest));
    assert_eq!(report.verdict, Verdict::Ok, "{report:?}");
    let index = report.keyword_index.unwrap();
    assert_eq!((index.state, index.cursor), ("incomplete", state.cursor));
    assert!(
        index.pages_checked > 0 && index.pages_checked < 40,
        "{index:?}"
    );
    assert_eq!(files(&copy), before);

    // A normal open of the same copy moves the generation: the builder commits.
    let opened = Store::open_dir(&copy, OpenOptions::default()).unwrap();
    while !opened.keyword_index_state().unwrap().unwrap().complete {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(opened.commit_version().unwrap() > manifest.generation);
    drop(opened);
    let after = verify(&copy, Some(&manifest));
    assert_eq!(after.verdict, Verdict::Mismatch);
    assert!(
        after.mismatches.contains(&"generation".to_owned()),
        "{after:?}"
    );
}

#[test]
fn a_damaged_complete_index_fails_and_an_older_readable_format_verifies_without_an_upgrade() {
    let dir = TempDir::new("verify-index-format");
    let (_store, copy, _manifest) = copy_of(&dir, 20, 0);
    // A posting that the pages do not explain.
    edit(&copy, |tx| {
        let postings = collect_prefix(&*tx, &[keys::TRIGRAM], false, 100).unwrap();
        let victim = postings
            .iter()
            .find(|(k, _)| *k != keys::keyword_index_state())
            .unwrap();
        tx.delete(&victim.0).unwrap();
    });
    let report = verify(&copy, None);
    assert_eq!(report.verdict, Verdict::Mismatch, "{report:?}");
    assert_eq!(report.mismatches, ["keyword_index"]);

    // Format 3 in the record and in FORMAT: the file is read as it is, not upgraded.
    let dir = TempDir::new("verify-format-3");
    let (_store, copy, _) = copy_of(&dir, 5, 0);
    edit(&copy, |tx| {
        let mut record: serde_json::Value =
            serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
        record["format_version"] = 3.into();
        tx.put(&keys::meta("format"), &serde_json::to_vec(&record).unwrap())
            .unwrap();
    });
    let format = std::fs::read_to_string(copy.join("FORMAT")).unwrap();
    let older = format.replace(
        &format!("\"format_version\": {}", gbrain_store::FORMAT_VERSION),
        "\"format_version\": 3",
    );
    std::fs::write(copy.join("FORMAT"), older).unwrap();
    let before = files(&copy);
    let report = verify(&copy, None);
    assert_eq!(report.verdict, Verdict::Ok, "{report:?}");
    assert_eq!(report.engine_format_version, Some(3));
    assert_eq!(files(&copy), before, "no upgrade ran");
}

#[test]
fn extra_missing_empty_and_changed_tags_are_each_a_mismatch_by_tag() {
    let dir = TempDir::new("verify-tags");
    let (_store, copy, manifest) = copy_of(&dir, 10, 0);
    let one = |expected: &SnapshotManifest| verify(&copy, Some(expected));

    let mut missing = manifest.clone();
    let removed = missing.tags.remove("50").unwrap();
    missing.keys -= removed.keys;
    assert_eq!(one(&missing).mismatches, ["keys", "tag_extra:50"]);

    let mut extra = manifest.clone();
    extra.tags.insert("ff".into(), removed.clone());
    extra.keys += removed.keys;
    assert_eq!(one(&extra).mismatches, ["keys", "tag_missing:ff"]);

    let mut changed = manifest.clone();
    changed.tags.get_mut("50").unwrap().sha256 = "0".repeat(64);
    assert_eq!(one(&changed).mismatches, ["tag_digest:50"]);

    let mut empty = manifest.clone();
    empty.tags.clear();
    empty.keys = 0;
    let report = one(&empty);
    assert_eq!(report.verdict, Verdict::Mismatch);
    assert!(report.mismatches.contains(&format!("tag_extra:{}", "50")));

    // A manifest that does not add up is refused before any file is read.
    let mut lies = manifest.clone();
    lies.keys += 1;
    let error = verify_store_dir(&copy, Some(&lies)).unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
    let mut newer = manifest;
    newer.version += 1;
    assert_eq!(
        verify_store_dir(&copy, Some(&newer)).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_changed_value_names_its_tag_and_a_damaged_page_is_an_integrity_refusal() {
    let dir = TempDir::new("verify-flip");
    let (_store, copy, manifest) = copy_of(&dir, 10, 0);
    // A decodable change: a config value differs. The report names the tag, never the key.
    let kv_copy = dir.path().join("edited");
    std::fs::create_dir(&kv_copy).unwrap();
    for (name, bytes) in files(&copy) {
        std::fs::write(kv_copy.join(name), bytes).unwrap();
    }
    edit(&kv_copy, |tx| {
        tx.put(&keys::text(keys::CONFIG, &["version"]), b"1")
            .unwrap()
    });
    let report = verify(&kv_copy, Some(&manifest));
    assert_eq!(report.verdict, Verdict::Mismatch);
    assert!(
        report.mismatches.contains(&"tag_digest:43".to_owned()),
        "{report:?}"
    );
    assert!(
        report
            .mismatches
            .iter()
            .all(|m| m.split(':').count() <= 2 && !m.contains("config"))
    );

    // A flipped byte inside a stored value is a decodable change: redb does not checksum leaf
    // values on read, so the report names the tag that holds it (chunk text is under tag 4b).
    let path = copy.join("records.redb");
    let mut bytes = std::fs::read(&path).unwrap();
    let at = bytes
        .windows(MARKER.len())
        .position(|w| w == MARKER.as_bytes())
        .expect("the page text is in the file");
    bytes[at + 3] ^= 0x01;
    std::fs::write(&path, &bytes).unwrap();
    let report = verify(&copy, Some(&manifest));
    assert_eq!(report.verdict, Verdict::Mismatch, "{report:?}");
    assert!(
        report.mismatches.contains(&"tag_digest:4b".to_owned()),
        "{report:?}"
    );

    // A structural change: a byte of the file's own header differs. redb refuses the file, and
    // the verdict is its own, not a tag mismatch.
    bytes[at + 3] ^= 0x01;
    let sound = bytes.clone();
    bytes[14] ^= 0x10;
    std::fs::write(&path, &bytes).unwrap();
    let report = verify(&copy, Some(&manifest));
    assert_eq!(report.verdict, Verdict::Integrity, "{report:?}");
    assert_eq!(report.integrity, Some("store_corrupt"));
    assert!(report.mismatches.is_empty() && report.tags.is_empty());

    // A flipped byte inside the pages can make redb panic instead of refuse. Verification
    // answers for every such file; it never takes the process down.
    let mut refused = 0;
    for offset in (8192..8192 + 4096 * 8).step_by(61) {
        let mut damaged = sound.clone();
        damaged[offset] ^= 0x10;
        std::fs::write(&path, &damaged).unwrap();
        refused += usize::from(verify(&copy, Some(&manifest)).verdict == Verdict::Integrity);
    }
    assert!(refused > 0, "some flips are refused as damaged files");
}

#[test]
fn a_missing_or_foreign_format_file_is_a_mismatch_and_a_missing_record_file_is_an_error() {
    let dir = TempDir::new("verify-format-file");
    let (_store, copy, manifest) = copy_of(&dir, 3, 0);
    let format = std::fs::read(copy.join("FORMAT")).unwrap();
    std::fs::remove_file(copy.join("FORMAT")).unwrap();
    assert_eq!(
        verify(&copy, Some(&manifest)).mismatches,
        ["format_file_missing"]
    );
    let text = String::from_utf8(format).unwrap();
    let foreign = text.replace(&manifest.brain_id, "00000000-0000-4000-8000-000000000000");
    std::fs::write(copy.join("FORMAT"), foreign).unwrap();
    assert_eq!(
        verify(&copy, Some(&manifest)).mismatches,
        ["format_file_brain_id"]
    );
    std::fs::remove_file(copy.join("records.redb")).unwrap();
    assert_eq!(verify_store_dir(&copy, None).unwrap_err().code, STORE_IO);
}

/// A record file copied while the brain is open was not closed cleanly: redb would repair it on
/// a writable open, and verification refuses to repair anything.
#[test]
fn a_file_that_was_not_closed_cleanly_is_refused_not_repaired() {
    let dir = TempDir::new("verify-unclean");
    let store = Store::open_dir(&dir.path().join("brain"), plain()).unwrap();
    put(&store, 1);
    let copy = dir.path().join("hot");
    std::fs::create_dir(&copy).unwrap();
    std::fs::copy(
        dir.path().join("brain/records.redb"),
        copy.join("records.redb"),
    )
    .unwrap();
    std::fs::copy(dir.path().join("brain/FORMAT"), copy.join("FORMAT")).unwrap();
    let before = files(&copy);
    let error = verify_store_dir(&copy, None).unwrap_err();
    assert_eq!(error.code, STORE_IO, "{}", error.message);
    assert_eq!(files(&copy), before);
}

/// A copy of a seeded store carries one digest per relation, streamed from the pinned read.
#[test]
fn a_seeded_store_copy_carries_and_checks_its_relation_digests() {
    let dir = TempDir::new("verify-seeded");
    let store = Store::open_dir(&dir.path().join("brain"), plain()).unwrap();
    let row = |k: &str, v: &str| -> gbrain_store::seed::SeedRow {
        [("key", k), ("value", v)]
            .iter()
            .map(|(a, b)| ((*a).to_owned(), Some((*b).to_owned())))
            .collect()
    };
    let digests = [1u8, 2].map(|n| DigestInput {
        sort: format!("{n:02x}"),
        digest: format!("{n:02x}").repeat(32),
    });
    store
        .import_relation_with_digests(
            "seed-1",
            "config",
            vec![row("a", "1"), row("b", "2")],
            &digests,
        )
        .unwrap();
    let copy = dir.path().join("copy");
    let manifest = store.snapshot_to(&copy, &SnapshotOp::new()).unwrap();
    let relations = manifest.relations.clone().unwrap();
    let expected = store
        .relation_digest("seed-1", "config", None, None)
        .unwrap();
    assert_eq!(
        (relations["config"].rows, relations["config"].sha256.clone()),
        (expected.rows, expected.digest)
    );
    assert_eq!(verify(&copy, Some(&manifest)).verdict, Verdict::Ok);
    let mut forged = manifest;
    forged
        .relations
        .as_mut()
        .unwrap()
        .get_mut("config")
        .unwrap()
        .rows += 1;
    assert_eq!(verify(&copy, Some(&forged)).mismatches, ["relations"]);
}
