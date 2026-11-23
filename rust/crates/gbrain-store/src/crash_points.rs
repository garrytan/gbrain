//! Test-only crash points for the real-process crash cell (`scripts/rust-crash/`).
//!
//! Off unless `GBRAIN_TEST_RUST_CRASH_LOG` names a file when a brain opens. Then the record file
//! opens through [`CrashFile`], a plain file backend that appends one line to that log for every
//! page write, every fsync start and every fsync end (`write 12`, `sync 3`, `synced 3`). When the
//! event that `GBRAIN_TEST_RUST_CRASH_AT` names (`<kind>:<n>`, the n-th event of that kind in this
//! process) comes, it logs `freeze <kind> <n>` and stops the calling thread for good. The cell's
//! driver waits for that line and SIGKILLs the process, so the kill lands exactly there:
//!
//! - `write:<n>`: before a page write, so the commit has written some pages and not the rest;
//! - `sync:<n>`: before an fsync, so the commit's pages are written and not yet flushed;
//! - `synced:<n>`: after an fsync returned, so the commit is durable and its caller has no answer.
//!
//! Without the log variable the record file opens through redb's own file backend, as always, and
//! nothing in this file runs.

use crate::error::{Result, STORE_LOCKED, StoreError};
use crate::kv::FileBackend;
use std::ffi::OsString;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// The log file. Setting it turns the crash points on.
pub(crate) const LOG_VAR: &str = "GBRAIN_TEST_RUST_CRASH_LOG";
/// Where to freeze: `<kind>:<n>`. Unset: log every event and never freeze (the counting pass).
pub(crate) const AT_VAR: &str = "GBRAIN_TEST_RUST_CRASH_AT";

/// A point inside a commit where the cell can freeze the process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Write,
    Sync,
    Synced,
}

impl Event {
    fn name(self) -> &'static str {
        match self {
            Event::Write => "write",
            Event::Sync => "sync",
            Event::Synced => "synced",
        }
    }

    fn index(self) -> usize {
        match self {
            Event::Write => 0,
            Event::Sync => 1,
            Event::Synced => 2,
        }
    }

    fn parse(name: &str) -> Option<Event> {
        match name {
            "write" => Some(Event::Write),
            "sync" => Some(Event::Sync),
            "synced" => Some(Event::Synced),
            _ => None,
        }
    }
}

/// The crash points asked for at open: the log, and the event to freeze at, if any.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Plan {
    log: PathBuf,
    at: Option<(Event, u64)>,
}

/// The plan the environment asks for; `None` when the log variable is unset or empty.
pub(crate) fn plan() -> Result<Option<Plan>> {
    plan_from(
        std::env::var_os(LOG_VAR),
        std::env::var(AT_VAR).ok().filter(|v| !v.is_empty()),
    )
}

fn plan_from(log: Option<OsString>, at: Option<String>) -> Result<Option<Plan>> {
    let Some(log) = log.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let at = match at {
        None => None,
        Some(text) => {
            let parsed = text.split_once(':').and_then(|(kind, n)| {
                Some((
                    Event::parse(kind)?,
                    n.parse::<u64>().ok().filter(|n| *n > 0)?,
                ))
            });
            Some(parsed.ok_or_else(|| {
                StoreError::io(format!(
                    "{AT_VAR} is {text:?}; it takes write:<n>, sync:<n> or synced:<n> with n of 1 or more"
                ))
            })?)
        }
    };
    Ok(Some(Plan {
        log: PathBuf::from(log),
        at,
    }))
}

/// The record file as plain file I/O, with the crash points of [`Plan`]. It holds the same
/// exclusive file lock redb's own backend holds, so a second open fails with `store_locked`.
#[derive(Debug)]
pub(crate) struct CrashFile {
    file: Mutex<File>,
    log: Mutex<File>,
    at: Option<(Event, u64)>,
    counts: [AtomicU64; 3],
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CrashFile {
    pub(crate) fn open(path: &Path, plan: Plan) -> Result<CrashFile> {
        let io = |what: &str, e: std::io::Error| StoreError::io(format!("{what}: {e}"));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|e| io("opening the record file", e))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(StoreError::new(
                    STORE_LOCKED,
                    "another handle or process already has this brain open",
                ));
            }
            Err(TryLockError::Error(e)) => return Err(io("locking the record file", e)),
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&plan.log)
            .map_err(|e| io("opening the crash point log", e))?;
        Ok(CrashFile {
            file: Mutex::new(file),
            log: Mutex::new(log),
            at: plan.at,
            counts: Default::default(),
        })
    }

    /// Counts and logs `event`; at the planned event, logs the freeze and never returns.
    fn event(&self, event: Event) {
        let n = self.counts[event.index()].fetch_add(1, Ordering::SeqCst) + 1;
        let mut log = guard(&self.log);
        // A log that cannot be written cannot be checked either; the driver then sees no freeze line
        // and fails the run, so the error needs no other path.
        // Each line goes out in one `write` call: the log is opened for append, so a whole line then
        // lands intact even while the driver's worker appends its own lines to the same file. `writeln!`
        // would send the name, the space and the number as separate writes, and a line from the worker
        // could land between them.
        let _ = log.write_all(format!("{} {n}\n", event.name()).as_bytes());
        if self.at == Some((event, n)) {
            let _ = log.write_all(format!("freeze {} {n}\n", event.name()).as_bytes());
            let _ = log.sync_data();
            drop(log);
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
    }
}

impl FileBackend for CrashFile {
    fn size(&self) -> std::io::Result<u64> {
        Ok(guard(&self.file).metadata()?.len())
    }

    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        let mut file = guard(&self.file);
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(out)
    }

    fn write_at(&self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        self.event(Event::Write);
        let mut file = guard(&self.file);
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)
    }

    fn set_len(&self, len: u64) -> std::io::Result<()> {
        guard(&self.file).set_len(len)
    }

    fn sync(&self) -> std::io::Result<()> {
        self.event(Event::Sync);
        guard(&self.file).sync_data()?;
        self.event(Event::Synced);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kv::Kv;
    use crate::redb_kv::RedbKv;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crash-points-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_plan_is_off_without_a_log_and_parses_each_kind() {
        assert_eq!(plan_from(None, Some("write:1".into())).unwrap(), None);
        assert_eq!(plan_from(Some("".into()), None).unwrap(), None);
        let log = || Some(OsString::from("/x/log"));
        assert_eq!(
            plan_from(log(), None).unwrap(),
            Some(Plan {
                log: "/x/log".into(),
                at: None
            })
        );
        for (text, event) in [
            ("write:3", Event::Write),
            ("sync:1", Event::Sync),
            ("synced:12", Event::Synced),
        ] {
            let plan = plan_from(log(), Some(text.into())).unwrap().unwrap();
            let n = text.split_once(':').unwrap().1.parse().unwrap();
            assert_eq!(plan.at, Some((event, n)), "{text}");
        }
        for bad in ["write", "write:0", "fsync:2", "sync:x", ":3"] {
            let error = plan_from(log(), Some(bad.into())).unwrap_err();
            assert!(error.message.contains(AT_VAR), "{bad}: {}", error.message);
        }
    }

    #[test]
    fn a_commit_through_the_crash_file_logs_its_writes_and_one_fsync_and_survives_a_reopen() {
        let dir = scratch("log");
        let path = dir.join("records.redb");
        let log = dir.join("events.log");
        let open = || {
            let plan = Plan {
                log: log.clone(),
                at: None,
            };
            RedbKv::open_backend(Box::new(CrashFile::open(&path, plan).unwrap())).unwrap()
        };
        {
            let kv = open();
            std::fs::write(&log, "").unwrap();
            let mut tx = kv.begin_write().unwrap();
            tx.put(b"Ka", b"one").unwrap();
            assert_eq!(tx.commit().unwrap(), 1);
            let lines = std::fs::read_to_string(&log).unwrap();
            let kinds: Vec<&str> = lines
                .lines()
                .map(|l| l.split(' ').next().unwrap())
                .collect();
            assert!(kinds.contains(&"write"), "{lines}");
            // A durable commit ends with an fsync, and nothing is written after it returns.
            assert_eq!(kinds.last(), Some(&"synced"), "{lines}");
            let first_sync = kinds.iter().position(|k| *k == "sync").unwrap();
            assert_eq!(kinds[first_sync + 1], "synced", "{lines}");
        }
        let kv = open();
        assert_eq!(kv.version().unwrap(), 1);
        assert_eq!(
            kv.snapshot().unwrap().get(b"Ka").unwrap().as_deref(),
            Some(&b"one"[..])
        );
        drop(kv);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_second_open_of_the_crash_file_is_refused_as_locked() {
        let dir = scratch("lock");
        let path = dir.join("records.redb");
        let plan = || Plan {
            log: dir.join("events.log"),
            at: None,
        };
        let first = CrashFile::open(&path, plan()).unwrap();
        let second = CrashFile::open(&path, plan()).unwrap_err();
        assert_eq!(second.code, STORE_LOCKED);
        drop(first);
        CrashFile::open(&path, plan()).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
