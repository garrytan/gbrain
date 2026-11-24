//! Verifying a store directory that nothing has opened: the check that runs before any repair
//! (docs/designs/RUST_ENGINE.md, row 21b; `rust/docs/store/snapshot.md`).
//!
//! A normal open is not neutral. It upgrades an older format, repairs the member-access flag
//! and starts the keyword index builder, and each of those commits, so a correct copy would
//! change its generation and its records before anyone compared them. [`verify_store_dir`]
//! opens the record file only through `RedbReadOnlyKv`: it takes no write lock, runs no
//! recovery, commits nothing, and refuses a file that was not closed cleanly. It reads the commit
//! sequence, the format record, `FORMAT`, the schema version and every key (one pass), and
//! recomputes the digests that `SnapshotManifest` holds.
//!
//! Two callers:
//! - With `expected`, the restore of a snapshot: every field must be equal, and a tag that is
//!   missing or extra is a mismatch.
//! - Without it, the physical copy of a stopped store (the runbook above the archive cap), which
//!   has no manifest: the report states what the directory holds and the caller judges it.
//!
//! The keyword index is judged by its state. Complete: the full `verify_index`. Incomplete (the
//! builder had not finished when the copy was made): pages before the cursor are checked, the
//! cursor is reported, and the unbuilt tail is not called missing; the builder finishes it later.
//! A refusal by redb's own integrity checks is a verdict of its own, apart from a mismatch.

use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::format::{self, FORMAT_VERSIONS, RECORDS_FILE};
use crate::keyword;
use crate::kv::{Kv, KvRead, scan_prefix};
use crate::redb_kv::RedbReadOnlyKv;
use crate::snapshot::{Inventory, RelationDigest, SnapshotManifest, TagDigest, relation_digests};
use crate::{StoredFormat, config, get_json, keys};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// The outcome of a verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Everything compared is equal (or nothing was given to compare).
    Ok,
    /// The records read fine and differ from `expected`; `mismatches` names each field.
    Mismatch,
    /// redb's own checks refused the file: the bytes are damaged.
    Integrity,
}

/// The state of the keyword index in the verified records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexCheck {
    /// `complete`, `incomplete` or `absent` (a store older than format 4 keeps no index).
    pub state: &'static str,
    /// Where the unfinished build stands (`incomplete` only): pages before it were checked.
    pub cursor: Option<u64>,
    pub pages_checked: u64,
    pub ok: bool,
}

/// What `verify_store_dir` found. Fields are `None` or empty when the verdict is `integrity`
/// and the records could not be read that far.
#[derive(Debug, Clone, Serialize)]
pub struct VerifyReport {
    pub verdict: Verdict,
    /// The code of the refusal when the verdict is `integrity`.
    pub integrity: Option<&'static str>,
    pub brain_id: Option<String>,
    pub generation: Option<u64>,
    /// The format record inside the records.
    pub engine_format_version: Option<u32>,
    /// The format `FORMAT` states; `None` when the file is missing.
    pub format_file_version: Option<u32>,
    pub schema_version: Option<u32>,
    pub keys: u64,
    pub bytes: u64,
    pub tags: BTreeMap<String, TagDigest>,
    pub relations: Option<BTreeMap<String, RelationDigest>>,
    pub keyword_index: Option<IndexCheck>,
    /// What differs from `expected`, as codes (`generation`, `tag_digest:50`, `tag_missing:50`,
    /// `tag_extra:50`, `relation:<name>`, ...): never a key or a value.
    pub mismatches: Vec<String>,
}

impl VerifyReport {
    fn empty() -> Self {
        Self {
            verdict: Verdict::Ok,
            integrity: None,
            brain_id: None,
            generation: None,
            engine_format_version: None,
            format_file_version: None,
            schema_version: None,
            keys: 0,
            bytes: 0,
            tags: BTreeMap::new(),
            relations: None,
            keyword_index: None,
            mismatches: Vec::new(),
        }
    }
}

/// Verifies the brain directory `dir` as described in the module docs. It writes nothing.
///
/// Errors: `store_io` when the record file is missing, unreadable or was not closed cleanly,
/// `store_locked` while a writable handle has it open, `format_unknown` for a `FORMAT` this build
/// does not read, `invalid_argument` for an `expected` that does not validate. A damaged file is
/// not an error: it is the `integrity` verdict.
pub fn verify_store_dir(dir: &Path, expected: Option<&SnapshotManifest>) -> Result<VerifyReport> {
    if let Some(expected) = expected {
        expected.validate()?;
    }
    let format_file = format::read_in(dir, FORMAT_VERSIONS)?;
    let mut report = VerifyReport::empty();
    report.format_file_version = format_file.as_ref().map(|f| f.format_version);
    // redb can panic, not only refuse, on a page whose bytes were damaged: that is the same
    // verdict, not a crash of the process that asked.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        RedbReadOnlyKv::open_path(&dir.join(RECORDS_FILE))
            .and_then(|kv| read_records(&kv, &mut report))
    }));
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(e)) if e.code == STORE_CORRUPT => return Ok(damaged(report, STORE_CORRUPT)),
        Ok(Err(e)) => return Err(e),
        Err(_) => return Ok(damaged(report, READ_PANICKED)),
    }
    match &format_file {
        None => report.mismatches.push("format_file_missing".into()),
        Some(file) => {
            if Some(file.format_version) != report.engine_format_version {
                report.mismatches.push("format_file_version".into());
            }
            if Some(&file.brain_id) != report.brain_id.as_ref() {
                report.mismatches.push("format_file_brain_id".into());
            }
        }
    }
    if let Some(expected) = expected {
        compare(&mut report, expected);
    }
    if report.keyword_index.as_ref().is_some_and(|i| !i.ok) {
        report.mismatches.push("keyword_index".into());
    }
    if !report.mismatches.is_empty() {
        report.verdict = Verdict::Mismatch;
    }
    Ok(report)
}

/// The `integrity` code of a file on which redb panicked instead of refusing.
const READ_PANICKED: &str = "read_panicked";

/// The report of a file whose bytes are damaged: only what was read before the refusal is kept.
fn damaged(mut report: VerifyReport, why: &'static str) -> VerifyReport {
    report.verdict = Verdict::Integrity;
    report.integrity = Some(why);
    report
}

/// Fills `report` from the records: one snapshot, so every field describes one generation.
fn read_records(kv: &RedbReadOnlyKv, report: &mut VerifyReport) -> Result<()> {
    let (read, generation) = kv.versioned_snapshot()?;
    let read: &dyn KvRead = &*read;
    report.generation = Some(generation);
    let stored: StoredFormat = get_json(read, &keys::meta("format"))?
        .ok_or_else(|| StoreError::new(STORE_CORRUPT, "the format record is missing"))?;
    report.brain_id = Some(stored.brain_id);
    report.engine_format_version = Some(stored.format_version);
    report.schema_version = Some(
        config::read_config(read, "version")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    );
    let mut inventory = Inventory::default();
    inventory.scan(read)?;
    (report.keys, report.bytes, report.tags) = inventory.finish();
    report.relations = relation_digests(read, None)?;
    report.keyword_index = Some(check_index(read)?);
    Ok(())
}

fn check_index(read: &dyn KvRead) -> Result<IndexCheck> {
    let Some(state) = keyword::read_index_state(read)? else {
        return Ok(IndexCheck {
            state: "absent",
            cursor: None,
            pages_checked: 0,
            ok: true,
        });
    };
    if state.complete {
        let report = keyword::verify_index(read, None)?;
        return Ok(IndexCheck {
            state: "complete",
            cursor: None,
            pages_checked: report.pages,
            ok: report.ok,
        });
    }
    // The pages before the cursor are indexed and kept in step; the pages from it on are the
    // builder's to do.
    let cursor = state.cursor.unwrap_or(0);
    let mut behind = 0u64;
    scan_prefix(read, &[keys::PAGE_ID], false, &mut |k, _| {
        if keys::be8(&k[1..]).is_some_and(|id| id < cursor) {
            behind += 1;
            return true;
        }
        false
    })?;
    let report = if behind == 0 {
        None
    } else {
        Some(keyword::verify_index(read, Some(behind))?)
    };
    Ok(IndexCheck {
        state: "incomplete",
        cursor: Some(cursor),
        pages_checked: behind,
        ok: report.is_none_or(|r| r.ok),
    })
}

fn compare(report: &mut VerifyReport, expected: &SnapshotManifest) {
    let mut codes = Vec::new();
    let mut check = |same: bool, code: &str| {
        if !same {
            codes.push(code.to_owned());
        }
    };
    check(
        report.brain_id.as_deref() == Some(expected.brain_id.as_str()),
        "brain_id",
    );
    check(report.generation == Some(expected.generation), "generation");
    check(
        report.engine_format_version == Some(expected.engine_format_version),
        "engine_format_version",
    );
    check(
        report.schema_version == Some(expected.schema_version),
        "schema_version",
    );
    check(report.keys == expected.keys, "keys");
    check(report.bytes == expected.bytes, "bytes");
    check(report.relations == expected.relations, "relations");
    for (tag, digest) in &expected.tags {
        match report.tags.get(tag) {
            None => codes.push(format!("tag_missing:{tag}")),
            Some(found) if found != digest => codes.push(format!("tag_digest:{tag}")),
            Some(_) => {}
        }
    }
    for tag in report
        .tags
        .keys()
        .filter(|t| !expected.tags.contains_key(*t))
    {
        codes.push(format!("tag_extra:{tag}"));
    }
    report.mismatches.extend(codes);
}
