//! Diverged-tail recovery and the replica mark of a follower (multi-user mode with the commit log;
//! rust/docs/store/commit-log.md, "Diverged tail recovery").
//!
//! A follower (or an old primary turned follower) whose cursor is past the point where its history
//! and the primary's split holds a diverged tail: commits the primary's history never had. Applying
//! or installing over it would drop them, so both refuse `diverged_tail` and change nothing until:
//!
//! 1. `Follower::export_diverged_tail(dir, theirs)` writes a recovery directory: a complete image of
//!    the follower (`records.redb`, `FORMAT`, `SNAPSHOT.json`, the snapshot publication), then
//!    `tail.jsonl` (a header line, then one line per retained record past the fork), then
//!    `MANIFEST.json` with the sha256 of every other file, written and synced last. The image keeps
//!    every value, also those whose records retention trimmed.
//! 2. `Follower::allow_install_over(dir)` checks the manifest digests, the header against the
//!    follower now (brain, cursor, lineage, fork), the image's newest commit and the tail's records
//!    against the follower's own, then permits one install over exactly that tail. A follower that
//!    restarts needs the export directory passed again.
//!
//! The replica mark (`REPLICA-MARK` in the follower directory, outside the replicated records): the
//! largest primary acked position (`repl_mark`) the follower heard on its current timeline. A
//! promotion records it in its note (`PromotionNote::acked_seen`). It is never copied by a snapshot,
//! an export, a takeover or a rebuild.

use crate::commit_log::{self, CommitPosition, Timeline, decode_record, read_meta};
use crate::error::{INVALID_STATE, Result, StoreError};
use crate::follower::Follower;
use crate::format::{self, RECORDS_FILE};
use crate::kv::{Kv, KvRead};
use crate::redb_kv::{RedbReadOnlyKv, RedbSink};
use crate::snapshot::{self, MANIFEST_FILE, Reservation, SnapshotOp};
use crate::{StoredFormat, get_json, keys};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;

/// The refusal of an apply or install that would drop commits only this follower holds.
pub const DIVERGED_TAIL: &str = "diverged_tail";
/// The refusal of an export the destination's free space cannot hold.
pub const EXPORT_NO_SPACE: &str = "export_no_space";
/// The raw tail of an export.
pub const TAIL_FILE: &str = "tail.jsonl";
/// The digests of an export, written last.
pub const EXPORT_MANIFEST_FILE: &str = "MANIFEST.json";
/// The replica mark in the follower directory.
pub const MARK_FILE: &str = "REPLICA-MARK";
const TAIL_KIND: &str = "gbrain-diverged-tail";
const MANIFEST_KIND: &str = "gbrain-diverged-tail-manifest";
/// Room kept free beyond the image and the tail when an export checks its space.
const SPACE_MARGIN: u64 = 16 << 20;

/// Where the histories `mine` (at `cursor`) and `theirs` split, when the follower holds commits past
/// it: the `from` of the first timeline where the lineages differ, on either side. `None` when the
/// follower holds no commit the other history lacks.
pub fn diverged_tail(
    mine: &[Timeline],
    cursor: CommitPosition,
    theirs: &[Timeline],
) -> Option<CommitPosition> {
    let mut i = 0;
    while i < mine.len() && i < theirs.len() && mine[i] == theirs[i] {
        i += 1;
    }
    let fork = match (mine.get(i), theirs.get(i)) {
        (None, None) => return None,
        (Some(a), Some(b)) => a.from.min(b.from),
        (Some(a), None) => a.from,
        (None, Some(b)) => b.from,
    };
    (cursor > fork).then_some(fork)
}

pub(crate) fn diverged(why: String) -> StoreError {
    StoreError::new(DIVERGED_TAIL, why)
}

/// The refusal text of an apply or install over an unexported tail.
pub(crate) fn tail_refusal(
    fork: CommitPosition,
    cursor: CommitPosition,
    mine: &[Timeline],
    theirs: &[Timeline],
    trimmed_through: Option<CommitPosition>,
) -> StoreError {
    let retained = trimmed_through.is_none_or(|t| t <= fork);
    diverged(format!(
        "this follower holds commits after {} up to {} that the primary's history never had (this follower's lineage {}, the primary's {}; the tail is {}); export it with Follower::export_diverged_tail, then allow_install_over the export",
        fork.token(),
        cursor.token(),
        lineage_text(mine),
        lineage_text(theirs),
        if retained {
            "fully retained in the log"
        } else {
            "partly trimmed from the log, kept whole in the export's image"
        }
    ))
}

fn lineage_text(lineage: &[Timeline]) -> String {
    if lineage.is_empty() {
        return "[]".into();
    }
    let parts: Vec<String> = lineage
        .iter()
        .map(|t| format!("{}@{}", t.id, t.from.token()))
        .collect();
    format!("[{}]", parts.join(", "))
}

/// The header line of `tail.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailHeader {
    pub kind: String,
    pub v: u32,
    pub brain_id: String,
    pub fork: CommitPosition,
    pub cursor: CommitPosition,
    pub mine_lineage: Vec<Timeline>,
    pub theirs_lineage: Vec<Timeline>,
    #[serde(default)]
    pub trimmed_through: Option<CommitPosition>,
    /// Records in the tail file after the header.
    pub records: u64,
}

#[derive(Serialize, Deserialize)]
struct TailLine {
    sequence: u64,
    index: u32,
    bytes_b64: String,
}

#[derive(Serialize, Deserialize)]
struct ExportManifest {
    kind: String,
    v: u32,
    /// File name to the hex sha256 of its bytes.
    files: BTreeMap<String, String>,
}

/// An export read back (`read_diverged_tail`): the header and the retained records past the fork.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DivergedTail {
    pub header: TailHeader,
    pub records: Vec<(CommitPosition, Vec<u8>)>,
}

/// What `allow_install_over` permits: one install over exactly this tail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Allowance {
    pub(crate) cursor: CommitPosition,
    pub(crate) mine: Vec<Timeline>,
    pub(crate) fork: CommitPosition,
}

impl Allowance {
    pub(crate) fn covers(
        &self,
        cursor: CommitPosition,
        mine: &[Timeline],
        fork: CommitPosition,
    ) -> bool {
        self.cursor == cursor && self.mine == mine && self.fork == fork
    }
}

/// A step an export test stops after, leaving what it wrote as a crash would (no cleanup).
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportCrash {
    /// The directory exists, nothing in it.
    Reserved,
    /// The image is published, no tail.
    Image,
    /// The tail is published, no manifest.
    Tail,
    /// `MANIFEST.json.tmp` is written and synced but not renamed.
    ManifestTemp,
}

/// The replica mark (`REPLICA-MARK`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ReplicaMark {
    pub(crate) brain_id: String,
    /// The id of the timeline it was heard on (`None` on the brain's first timeline).
    pub(crate) timeline: Option<String>,
    pub(crate) acked: CommitPosition,
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (i, shift) in [18u32, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(B64[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub(crate) fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let value = |c: u8| B64.iter().position(|&b| b == c).map(|p| p as u32);
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (q, quad) in bytes.chunks(4).enumerate() {
        let last = q + 1 == bytes.len() / 4;
        let pad = quad.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for &c in &quad[..4 - pad] {
            n = (n << 6) | value(c)?;
        }
        n <<= 6 * pad as u32;
        let take = 3 - pad;
        out.extend_from_slice(&n.to_be_bytes()[1..1 + take]);
    }
    // Only the canonical form decodes: encoding the result gives the same text back.
    (b64_encode(&out) == text).then_some(out)
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).map_err(|e| {
        StoreError::io(format!(
            "diverged-tail export: reading {}: {}",
            path.display(),
            e.kind()
        ))
    })?;
    Ok(snapshot::hex(&Sha256::digest(&bytes)))
}

/// Free bytes for an unprivileged writer in the filesystem holding `dir`.
#[cfg(unix)]
fn free_bytes(dir: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| StoreError::invalid("diverged-tail export: the destination has a NUL"))?;
    // SAFETY: `path` is a NUL-terminated string that outlives the call; `stat` is written by it.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return Err(StoreError::io(format!(
            "diverged-tail export: free space of {}: {}",
            dir.display(),
            std::io::Error::last_os_error().kind()
        )));
    }
    #[allow(clippy::unnecessary_cast)]
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(not(unix))]
fn free_bytes(_dir: &Path) -> Result<u64> {
    Ok(u64::MAX)
}

/// Reads and checks an export directory: every digest of `MANIFEST.json`, then the tail file.
/// Errors name the file, never raw record bytes.
pub fn read_diverged_tail(dir: &Path) -> Result<DivergedTail> {
    let refuse = |why: String| diverged(format!("the export at {}: {why}", dir.display()));
    let manifest_bytes = std::fs::read(dir.join(EXPORT_MANIFEST_FILE)).map_err(|e| {
        refuse(format!(
            "{EXPORT_MANIFEST_FILE} cannot be read ({}): the export is incomplete",
            e.kind()
        ))
    })?;
    let manifest: ExportManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| refuse(format!("{EXPORT_MANIFEST_FILE} does not parse")))?;
    if manifest.kind != MANIFEST_KIND || manifest.v != 1 {
        return Err(refuse(format!(
            "{EXPORT_MANIFEST_FILE} is not a v1 export manifest"
        )));
    }
    for name in [RECORDS_FILE, format::FORMAT_FILE, MANIFEST_FILE, TAIL_FILE] {
        let Some(want) = manifest.files.get(name) else {
            return Err(refuse(format!(
                "{EXPORT_MANIFEST_FILE} lists no digest for {name}"
            )));
        };
        let got =
            sha256_file(&dir.join(name)).map_err(|_| refuse(format!("{name} cannot be read")))?;
        if &got != want {
            return Err(refuse(format!("{name} does not match its digest")));
        }
    }
    let text = std::fs::read_to_string(dir.join(TAIL_FILE))
        .map_err(|_| refuse(format!("{TAIL_FILE} is not text")))?;
    let mut lines = text.lines();
    let header: TailHeader = lines
        .next()
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| refuse(format!("{TAIL_FILE} has no header")))?;
    if header.kind != TAIL_KIND || header.v != 1 {
        return Err(refuse(format!("{TAIL_FILE} is not a v1 diverged tail")));
    }
    let mut records = Vec::new();
    let mut prev: Option<CommitPosition> = None;
    for (n, line) in lines.enumerate() {
        let line: TailLine = serde_json::from_str(line)
            .map_err(|_| refuse(format!("{TAIL_FILE} line {} does not parse", n + 2)))?;
        let position = CommitPosition::new(line.sequence, line.index);
        let bytes = b64_decode(&line.bytes_b64)
            .ok_or_else(|| refuse(format!("{TAIL_FILE} line {} is not base64", n + 2)))?;
        decode_record(&commit_log::record_key(position), &bytes)
            .map_err(|_| refuse(format!("{TAIL_FILE} line {} is not a commit record", n + 2)))?;
        if position <= header.fork
            || position > header.cursor
            || prev.is_some_and(|p| !position.follows(p))
        {
            return Err(refuse(format!(
                "{TAIL_FILE} line {} is out of order",
                n + 2
            )));
        }
        prev = Some(position);
        records.push((position, bytes));
    }
    if records.len() as u64 != header.records {
        return Err(refuse(format!(
            "{TAIL_FILE} holds {} records, its header says {}",
            records.len(),
            header.records
        )));
    }
    if records.last().is_some_and(|(p, _)| *p != header.cursor) {
        return Err(refuse(format!("{TAIL_FILE} does not end at its cursor")));
    }
    Ok(DivergedTail { header, records })
}

impl Follower {
    /// The retained records after `fork`, from the follower's own log.
    fn tail_records(
        read: &dyn KvRead,
        fork: CommitPosition,
    ) -> Result<Vec<(CommitPosition, Vec<u8>)>> {
        let mut out = Vec::new();
        let mut from = commit_log::record_key(fork);
        from.push(0);
        let mut failure = None;
        read.scan(&from, &[commit_log::COMMIT_LOG + 1], false, &mut |k, v| {
            match decode_record(k, v) {
                Ok(r) => out.push((r.position, v.to_vec())),
                Err(e) => failure = Some(e),
            }
            failure.is_none()
        })?;
        failure.map_or(Ok(out), Err)
    }

    /// Writes the diverged tail of this follower against the history `theirs` into the new
    /// directory `dir` (module docs). Refused: no tail, a follower without a directory, a
    /// destination that exists, overlaps the follower or sits under a symbolic link, too little
    /// free space (`export_no_space`). Any failure removes what it made and grants nothing.
    pub fn export_diverged_tail(&self, dir: &Path, theirs: &[Timeline]) -> Result<TailHeader> {
        self.export_diverged_tail_with(dir, theirs, None)
    }

    /// `export_diverged_tail` with a crash point for tests: the call stops after `crash` and leaves
    /// what it wrote, as a process that died there would.
    #[doc(hidden)]
    pub fn export_diverged_tail_with(
        &self,
        dir: &Path,
        theirs: &[Timeline],
        crash: Option<ExportCrash>,
    ) -> Result<TailHeader> {
        let Some(home) = self.dir.as_deref() else {
            return Err(StoreError::new(
                INVALID_STATE,
                "a follower without a directory cannot export its tail",
            ));
        };
        // The state lock is held to the end: no apply or install changes the records meanwhile.
        let guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(state) = guard.as_ref() else {
            return Err(StoreError::new(
                INVALID_STATE,
                "an empty follower has no tail",
            ));
        };
        let meta = state.meta().clone();
        let cursor = meta.newest;
        let Some(fork) = diverged_tail(&meta.lineage, cursor, theirs) else {
            return Err(StoreError::new(
                INVALID_STATE,
                format!(
                    "this follower at {} holds no commit past where its history and {} split",
                    cursor.token(),
                    lineage_text(theirs)
                ),
            ));
        };
        let read = self.kv.snapshot()?;
        let brain_id = get_json::<StoredFormat>(&*read, &keys::meta("format"))?
            .map(|f| f.brain_id)
            .unwrap_or_default();
        let records = Follower::tail_records(&*read, fork)?;
        drop(read);
        let header = TailHeader {
            kind: TAIL_KIND.into(),
            v: 1,
            brain_id,
            fork,
            cursor,
            mine_lineage: meta.lineage.clone(),
            theirs_lineage: theirs.to_vec(),
            trimmed_through: meta.trimmed_through,
            records: records.len() as u64,
        };
        let mut tail = serde_json::to_vec(&header)?;
        tail.push(b'\n');
        for (position, bytes) in &records {
            serde_json::to_writer(
                &mut tail,
                &TailLine {
                    sequence: position.sequence,
                    index: position.index,
                    bytes_b64: b64_encode(bytes),
                },
            )?;
            tail.push(b'\n');
        }
        // The image is at most the record file's size; it and the tail must fit with a margin.
        let image = std::fs::metadata(home.join(RECORDS_FILE))
            .map(|m| m.len())
            .unwrap_or(0);
        let need = image
            .saturating_add(tail.len() as u64)
            .saturating_add(SPACE_MARGIN);
        let parent = match dir.parent() {
            Some(p) if !p.as_os_str().is_empty() => p,
            _ => Path::new("."),
        };
        let free = free_bytes(parent)?;
        if free < need {
            return Err(StoreError::new(
                EXPORT_NO_SPACE,
                format!(
                    "the export needs about {need} bytes (the image, the tail and a margin) and {} has {free} free",
                    parent.display()
                ),
            ));
        }
        let mut claim = Reservation::make(home, dir)?;
        let stop = |claim: &mut Reservation, at: ExportCrash| -> Option<Result<TailHeader>> {
            (crash == Some(at)).then(|| {
                claim.kept = true;
                Err(StoreError::io(format!(
                    "diverged-tail export: test crash after {at:?}"
                )))
            })
        };
        if let Some(out) = stop(&mut claim, ExportCrash::Reserved) {
            return out;
        }
        let written = (|| -> Result<Option<TailHeader>> {
            let record = format::read(home)?
                .ok_or_else(|| StoreError::new(INVALID_STATE, "the follower has no FORMAT file"))?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX));
            snapshot::copy_kv(
                &self.kv,
                record,
                &claim,
                &SnapshotOp::new(),
                true,
                |path: &Path| {
                    let sink = RedbSink::create_path(path)?;
                    // The directory is 0700; the image is the follower's whole store, so 0600 too.
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                            .map_err(|e| {
                                StoreError::io(format!("diverged-tail export: {}", e.kind()))
                            })?;
                    }
                    Ok(sink)
                },
                now,
            )?;
            if crash == Some(ExportCrash::Image) {
                return Ok(None);
            }
            claim.publish(TAIL_FILE, &tail)?;
            if crash == Some(ExportCrash::Tail) {
                return Ok(None);
            }
            let mut files = BTreeMap::new();
            for name in [RECORDS_FILE, format::FORMAT_FILE, MANIFEST_FILE, TAIL_FILE] {
                files.insert(name.to_owned(), sha256_file(&claim.root.join(name))?);
            }
            let mut body = serde_json::to_vec_pretty(&ExportManifest {
                kind: MANIFEST_KIND.into(),
                v: 1,
                files,
            })?;
            body.push(b'\n');
            if crash == Some(ExportCrash::ManifestTemp) {
                let temp = claim.root.join(format!("{EXPORT_MANIFEST_FILE}.tmp"));
                let mut file = std::fs::File::create(&temp)
                    .map_err(|e| StoreError::io(format!("test crash: {}", e.kind())))?;
                file.write_all(&body)
                    .and_then(|()| file.sync_all())
                    .map_err(|e| StoreError::io(format!("test crash: {}", e.kind())))?;
                return Ok(None);
            }
            claim.publish(EXPORT_MANIFEST_FILE, &body)?;
            claim.verify()?;
            Ok(Some(header.clone()))
        })();
        match written {
            Ok(Some(header)) => {
                claim.kept = true;
                Ok(header)
            }
            Ok(None) => {
                claim.kept = true;
                Err(StoreError::io(format!(
                    "diverged-tail export: test crash after {:?}",
                    crash.unwrap_or(ExportCrash::Reserved)
                )))
            }
            Err(error) => match claim.cleanup() {
                Ok(()) => Err(error),
                Err(left) => Err(StoreError::io(format!(
                    "{} (the export stopped with {})",
                    left.message, error.code
                ))),
            },
        }
    }

    /// Checks the export in `dir` against the follower now (module docs) and permits one install
    /// over exactly that tail. Returns the export's header.
    pub fn allow_install_over(&self, dir: &Path) -> Result<TailHeader> {
        let export = read_diverged_tail(dir)?;
        let header = export.header;
        let refuse = |why: String| diverged(format!("the export at {}: {why}", dir.display()));
        // The image is the follower's whole store at the cursor.
        let image = RedbReadOnlyKv::open_path(&dir.join(RECORDS_FILE))
            .map_err(|_| refuse(format!("its {RECORDS_FILE} does not open")))?;
        let image_read = image.snapshot()?;
        let image_meta = read_meta(&*image_read)?
            .ok_or_else(|| refuse("its image keeps no commit log".into()))?;
        let image_brain = get_json::<StoredFormat>(&*image_read, &keys::meta("format"))?
            .map(|f| f.brain_id)
            .unwrap_or_default();
        drop(image_read);
        if image_meta.newest != header.cursor || image_brain != header.brain_id {
            return Err(refuse("its image does not end at its tail's cursor".into()));
        }
        let guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(state) = guard.as_ref() else {
            return Err(refuse("this follower holds no brain".into()));
        };
        let meta = state.meta();
        let read = self.kv.snapshot()?;
        let brain_id = get_json::<StoredFormat>(&*read, &keys::meta("format"))?
            .map(|f| f.brain_id)
            .unwrap_or_default();
        if header.brain_id != brain_id {
            return Err(refuse("it is another brain's".into()));
        }
        if header.cursor != meta.newest || header.mine_lineage != meta.lineage {
            return Err(refuse(format!(
                "it was written at {}, this follower is at {} now",
                header.cursor.token(),
                meta.newest.token()
            )));
        }
        if diverged_tail(&meta.lineage, meta.newest, &header.theirs_lineage) != Some(header.fork) {
            return Err(refuse("its fork is not this follower's".into()));
        }
        if Follower::tail_records(&*read, header.fork)? != export.records {
            return Err(refuse("its records are not this follower's tail".into()));
        }
        drop(read);
        *self.allowance.lock().unwrap_or_else(|p| p.into_inner()) = Some(Allowance {
            cursor: header.cursor,
            mine: header.mine_lineage.clone(),
            fork: header.fork,
        });
        drop(guard);
        Ok(header)
    }

    /// Whether an install over the tail at `fork` is permitted (and the permission it uses).
    pub(crate) fn allowed_over(
        &self,
        cursor: CommitPosition,
        mine: &[Timeline],
        fork: CommitPosition,
    ) -> bool {
        self.allowance
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|a| a.covers(cursor, mine, fork))
    }

    pub(crate) fn clear_allowance(&self) {
        *self.allowance.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Records the primary's acked position (`repl_mark`) when it is newer than the mark the
    /// follower holds on its current timeline: written to `REPLICA-MARK` (temporary file, sync,
    /// rename, directory sync) before it counts. Returns whether it moved.
    pub fn note_primary_acked(&self, acked: CommitPosition) -> Result<bool> {
        let guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(state) = guard.as_ref() else {
            return Err(StoreError::new(
                INVALID_STATE,
                "an empty follower keeps no mark",
            ));
        };
        let timeline = state.meta().lineage.last().map(|t| t.id.clone());
        let brain_id = get_json::<StoredFormat>(&*self.kv.snapshot()?, &keys::meta("format"))?
            .map(|f| f.brain_id)
            .unwrap_or_default();
        let mut mark = self.mark.lock().unwrap_or_else(|p| p.into_inner());
        if mark
            .as_ref()
            .is_some_and(|m| m.brain_id == brain_id && m.timeline == timeline && m.acked >= acked)
        {
            return Ok(false);
        }
        let next = ReplicaMark {
            brain_id,
            timeline,
            acked,
        };
        if let Some(dir) = &self.dir {
            write_mark(dir, &next)?;
        }
        *mark = Some(next);
        Ok(true)
    }

    /// The primary acked position the follower heard on its current timeline, if any.
    pub fn primary_acked(&self) -> Option<CommitPosition> {
        let guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let timeline = guard
            .as_ref()
            .and_then(|s| s.meta().lineage.last().map(|t| t.id.clone()));
        self.mark
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|m| m.timeline == timeline)
            .map(|m| m.acked)
    }

    /// The mark in the follower directory, kept only for this brain.
    pub(crate) fn load_mark(&self) -> Result<()> {
        let Some(dir) = &self.dir else {
            return Ok(());
        };
        // A missing or unreadable mark is no mark: it only ever adds evidence to a promotion note.
        let Ok(bytes) = std::fs::read(dir.join(MARK_FILE)) else {
            return Ok(());
        };
        let Ok(mark) = serde_json::from_slice::<ReplicaMark>(&bytes) else {
            return Ok(());
        };
        let brain = self.brain_id()?;
        if brain.as_deref() == Some(mark.brain_id.as_str()) {
            *self.mark.lock().unwrap_or_else(|p| p.into_inner()) = Some(mark);
        }
        Ok(())
    }
}

fn write_mark(dir: &Path, mark: &ReplicaMark) -> Result<()> {
    let io = |what: &str, e: std::io::Error| {
        StoreError::io(format!("{MARK_FILE}: {what}: {}", e.kind()))
    };
    let temp = dir.join(format!("{MARK_FILE}.tmp"));
    let mut body = serde_json::to_vec(mark)?;
    body.push(b'\n');
    let mut file = std::fs::File::create(&temp).map_err(|e| io("creating", e))?;
    file.write_all(&body).map_err(|e| io("writing", e))?;
    file.sync_all().map_err(|e| io("syncing", e))?;
    drop(file);
    std::fs::rename(&temp, dir.join(MARK_FILE)).map_err(|e| io("renaming", e))?;
    #[cfg(unix)]
    std::fs::File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| io("syncing the directory", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: u64) -> CommitPosition {
        CommitPosition::new(s, 0)
    }

    fn t(id: &str, s: u64) -> Timeline {
        Timeline {
            id: id.into(),
            from: at(s),
        }
    }

    #[test]
    fn the_fork_is_the_first_timeline_where_the_histories_differ() {
        assert_eq!(diverged_tail(&[], at(5), &[]), None);
        // The primary promoted at 7; this follower stopped at 5 or 7: nothing of its own.
        assert_eq!(diverged_tail(&[], at(7), &[t("a", 7)]), None);
        assert_eq!(diverged_tail(&[], at(9), &[t("a", 7)]), Some(at(7)));
        assert_eq!(diverged_tail(&[t("a", 7)], at(9), &[t("a", 7)]), None);
        assert_eq!(
            diverged_tail(&[t("a", 7)], at(9), &[t("x", 8)]),
            Some(at(7))
        );
        // This follower promoted itself at 6; the primary never heard of it.
        assert_eq!(diverged_tail(&[t("b", 6)], at(9), &[]), Some(at(6)));
        assert_eq!(
            diverged_tail(&[t("a", 3), t("b", 6)], at(9), &[t("a", 3), t("c", 8)]),
            Some(at(6))
        );
        // Wherever `lineage_continues` holds, there is no tail.
        for (mine, cursor, theirs) in [
            (vec![], at(5), vec![t("a", 5)]),
            (vec![t("a", 3)], at(9), vec![t("a", 3), t("b", 9)]),
        ] {
            assert!(commit_log::lineage_continues(&mine, cursor, &theirs));
            assert_eq!(diverged_tail(&mine, cursor, &theirs), None);
        }
    }

    #[test]
    fn base64_round_trips_and_refuses_non_canonical_text() {
        for n in 0..70usize {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            let text = b64_encode(&bytes);
            assert_eq!(b64_decode(&text).as_deref(), Some(bytes.as_slice()), "{n}");
        }
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        for bad in ["Zm8", "Zm9=v", "Zm9===", "Zm*=", "Zm9=Zm8="] {
            assert_eq!(b64_decode(bad), None, "{bad}");
        }
        // A pad position with stray bits is not canonical.
        assert_eq!(b64_decode("Zm9="), None);
    }
}
