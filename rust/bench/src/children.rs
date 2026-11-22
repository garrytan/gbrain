//! Work that must happen in a different process: cold open, crash writer, second-process probe,
//! and owner-socket clients. The parent starts these by re-running this same executable with a
//! `child-*` subcommand (see main.rs), so there is one binary and nothing to install.

use crate::engine::{open_records, Engine};
use crate::keys::*;
use crate::kv::*;
use crate::occ::read_version;
use crate::owner::OwnerClient;
use crate::records::{decode_page, decode_page_id_value, Records};
use crate::synth::*;
use crate::util::Rng;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

// ---- parent side: running a child ------------------------------------------------------------

pub struct ChildRun {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub wall_ms: f64,
    pub timed_out: bool,
    pub success: bool,
}

fn drain<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.read_to_end(&mut buf);
        buf
    })
}

/// Run this executable with `args`, killing it if it takes longer than `timeout`.
pub fn run_child(args: &[String], timeout: Duration) -> std::io::Result<ChildRun> {
    let started = Instant::now();
    let mut child = Command::new(std::env::current_exe()?)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let out = drain(child.stdout.take().unwrap());
    let err = drain(child.stderr.take().unwrap());
    let mut timed_out = false;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if started.elapsed() > timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait()?;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    Ok(ChildRun {
        stdout: out.join().unwrap_or_default(),
        stderr: String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned(),
        wall_ms: started.elapsed().as_secs_f64() * 1000.0,
        timed_out,
        success: status.success(),
    })
}

pub fn last_json_line(bytes: &[u8]) -> Option<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

// ---- child: cold open ------------------------------------------------------------------------

pub fn child_cold_open(
    engine: Engine,
    store: &Path,
    commit_log: bool,
    source: &str,
    slug: &str,
) -> i32 {
    let t0 = Instant::now();
    let records = match open_records(engine, store, commit_log) {
        Ok(r) => r,
        Err(e) => {
            println!("{}", json!({"ok": false, "message": e.to_string()}));
            return 1;
        }
    };
    let open = t0.elapsed();
    let t1 = Instant::now();
    let found = matches!(records.get_page(source, slug), Ok(Some(_)));
    let first = t1.elapsed();
    println!(
        "{}",
        json!({"ok": true, "found": found, "ms": ms(open + first), "open_ms": ms(open), "first_get_ms": ms(first)})
    );
    0
}

// ---- child: second-process probe -------------------------------------------------------------

pub fn child_probe_open(
    engine: Engine,
    store: &Path,
    commit_log: bool,
    source: &str,
    slug: &str,
) -> i32 {
    let t0 = Instant::now();
    match open_records(engine, store, commit_log) {
        Ok(records) => {
            let open = t0.elapsed();
            let t1 = Instant::now();
            let found = matches!(records.get_page(source, slug), Ok(Some(_)));
            println!(
                "{}",
                json!({"ok": true, "found": found, "open_ms": ms(open), "first_get_ms": ms(t1.elapsed())})
            );
            0
        }
        Err(e) => {
            println!(
                "{}",
                json!({"ok": false, "message": e.to_string(), "open_ms": ms(t0.elapsed())})
            );
            1
        }
    }
}

// ---- crash recovery --------------------------------------------------------------------------

const ACK_LEN: usize = 16;
const READY: u32 = u32::MAX;

fn write_stdout(buf: &[u8]) {
    // SAFETY: raw write(2) to fd 1; 16 bytes is below PIPE_BUF so each ack is atomic.
    unsafe {
        libc::write(1, buf.as_ptr().cast(), buf.len());
    }
}

/// Opens the store, says READY, then 4 writer threads commit pages as fast as they can and write
/// one 16-byte ack (writer u32, n u32, commit version u64) per durable commit. Never returns:
/// the parent kills it with SIGKILL.
pub fn child_crash(engine: Engine, store: &Path, commit_log: bool) -> i32 {
    let records = match open_records(engine, store, commit_log) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("crash child could not open the store: {e}");
            return 1;
        }
    };
    let mut ready = [0u8; ACK_LEN];
    ready[0..4].copy_from_slice(&READY.to_le_bytes());
    ready[4..8].copy_from_slice(&READY.to_le_bytes());
    write_stdout(&ready);
    for w in 0..4u32 {
        let records = records.clone();
        std::thread::spawn(move || {
            let mut n = 0u32;
            loop {
                let (mut page, chunks) = crash_page(w, n);
                page.id = records.alloc_page_id();
                if let Ok(version) = records.put_page_with_chunks(&page, &chunks) {
                    let mut ack = [0u8; ACK_LEN];
                    ack[0..4].copy_from_slice(&w.to_le_bytes());
                    ack[4..8].copy_from_slice(&n.to_le_bytes());
                    ack[8..16].copy_from_slice(&version.to_le_bytes());
                    write_stdout(&ack);
                }
                n = n.wrapping_add(1);
            }
        });
    }
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

pub struct CrashRun {
    /// (writer, n, commit version) for every acknowledged write.
    pub acked: Vec<(u32, u32, u64)>,
    pub ready: bool,
    pub stderr: String,
}

/// Start the crash child, wait for READY, let it write for `kill_after`, SIGKILL it.
pub fn run_crash_writer(
    args: &[String],
    kill_after: Duration,
    ready_timeout: Duration,
) -> std::io::Result<CrashRun> {
    let mut child = Command::new(std::env::current_exe()?)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().unwrap();
    let err = drain(child.stderr.take().unwrap());
    let (tx, rx) = mpsc::channel::<()>();
    let reader = std::thread::spawn(move || {
        let mut all = Vec::new();
        let mut chunk = [0u8; 65536];
        let mut signalled = false;
        while let Ok(n) = stdout.read(&mut chunk) {
            if n == 0 {
                break;
            }
            all.extend_from_slice(&chunk[..n]);
            if !signalled {
                signalled = true;
                let _ = tx.send(());
            }
        }
        all
    });
    let ready = rx.recv_timeout(ready_timeout).is_ok();
    if ready {
        std::thread::sleep(kill_after);
    }
    let _ = child.kill(); // SIGKILL
    let _ = child.wait();
    let bytes = reader.join().unwrap_or_default();
    let mut acked = Vec::new();
    for rec in bytes.chunks_exact(ACK_LEN) {
        let w = u32::from_le_bytes(rec[0..4].try_into().unwrap());
        let n = u32::from_le_bytes(rec[4..8].try_into().unwrap());
        if w == READY && n == READY {
            continue;
        }
        acked.push((w, n, u64::from_le_bytes(rec[8..16].try_into().unwrap())));
    }
    Ok(CrashRun {
        acked,
        ready,
        stderr: String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned(),
    })
}

/// How many acknowledged writes are missing or hold different content after reopen.
pub fn count_lost(records: &Records, acked: &[(u32, u32, u64)]) -> u64 {
    let mut lost = 0;
    for &(w, n, _) in acked {
        let (_, want) = crash_page(w, n);
        let ok = match records.get_page(CRASH_SOURCE, &crash_slug(w, n)) {
            Ok(Some(p)) => matches!(records.get_chunks(p.id), Ok(got) if got == want),
            _ => false,
        };
        if !ok {
            lost += 1;
        }
    }
    lost
}

/// Whole-store structural check from ONE snapshot. Returns the list of problems (empty = consistent).
/// Checks: every page row has exactly `chunk_count` chunk rows numbered below it; no chunk row
/// belongs to a missing page; the page-id index and the page rows agree; and, when the commit log
/// is on, log versions are exactly 1..=meta/version with no gap.
pub fn check_consistency(records: &Records, check_log: bool) -> Result<Vec<String>> {
    let mut problems: Vec<String> = Vec::new();
    let note = |p: &mut Vec<String>, s: String| {
        if p.len() < 20 {
            p.push(s)
        }
    };
    records.db().read(|snap| {
        let (ps, pe) = (vec![PAGE], vec![PAGE + 1]);
        let mut pages: HashMap<u64, (u32, String, String)> = HashMap::new();
        let mut bad = Vec::new();
        snap.scan(Table::Data, &ps, &pe, false, &mut |_, v| {
            match decode_page(v) {
                Ok(p) => {
                    if pages
                        .insert(p.id, (p.chunk_count, p.source_id, p.slug))
                        .is_some()
                    {
                        bad.push(format!("two page rows share id {}", p.id));
                    }
                }
                Err(e) => bad.push(format!("undecodable page row: {e}")),
            }
            true
        })?;
        problems.append(&mut bad);

        let (is, ie) = page_id_range();
        let mut indexed = 0usize;
        let mut idx_problems = Vec::new();
        snap.scan(Table::Data, &is, &ie, false, &mut |k, v| {
            indexed += 1;
            match (parse_page_id_key(k), decode_page_id_value(v)) {
                (Some(id), Ok((s, sl))) => match pages.get(&id) {
                    Some((_, ps, psl)) if *ps == s && *psl == sl => {}
                    _ => idx_problems
                        .push(format!("page-id index entry {id} has no matching page row")),
                },
                _ => idx_problems.push("undecodable page-id index entry".to_string()),
            }
            true
        })?;
        problems.append(&mut idx_problems);
        if indexed != pages.len() {
            note(
                &mut problems,
                format!(
                    "{} page rows but {indexed} page-id index entries",
                    pages.len()
                ),
            );
        }

        let (cs, ce) = all_chunks_range();
        let mut counts: HashMap<u64, u32> = HashMap::new();
        let mut chunk_problems = Vec::new();
        snap.scan(Table::Data, &cs, &ce, false, &mut |k, _| {
            if let Some((page, idx)) = parse_chunk_key(k) {
                match pages.get(&page) {
                    None => {
                        chunk_problems.push(format!("orphan chunk row (page {page}, idx {idx})"))
                    }
                    Some((n, _, _)) if idx >= *n => chunk_problems.push(format!(
                        "page {page} has chunk idx {idx} but chunk_count {n}"
                    )),
                    _ => *counts.entry(page).or_default() += 1,
                }
            }
            true
        })?;
        problems.append(&mut chunk_problems);
        for (id, (n, _, slug)) in &pages {
            let have = counts.get(id).copied().unwrap_or(0);
            if have != *n {
                note(
                    &mut problems,
                    format!("page {id} ({slug}): chunk_count {n} but {have} chunk rows"),
                );
            }
        }

        if check_log {
            let version = read_version(snap)?;
            let mut next = 1u64;
            let mut log_problems = Vec::new();
            snap.scan(Table::Log, &[], &[0xff; 9], false, &mut |k, _| {
                let v = <[u8; 8]>::try_from(k).map(u64::from_be_bytes).unwrap_or(0);
                if v != next {
                    log_problems.push(format!("commit log jumps from {} to {v}", next - 1));
                    return false;
                }
                next += 1;
                true
            })?;
            problems.append(&mut log_problems);
            if next - 1 != version {
                note(
                    &mut problems,
                    format!(
                        "commit log ends at {} but meta/version is {version}",
                        next - 1
                    ),
                );
            }
        }
        Ok(())
    })?;
    Ok(problems)
}

// ---- child: owner-socket client --------------------------------------------------------------

/// Reads `source\tslug` lines, does `gets` GET_PAGEs at random from them and `puts` PUT_PAGEs of
/// new pages (4 chunks each) through the owner socket, and prints every latency in microseconds.
pub fn child_owner_client(
    socket: &Path,
    keys_file: &Path,
    gets: usize,
    puts: usize,
    seed: u64,
) -> i32 {
    let keys: Vec<(String, String)> = std::fs::read_to_string(keys_file)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            l.split_once('\t')
                .map(|(a, b)| (a.to_string(), b.to_string()))
        })
        .collect();
    let mut errors = 0u64;
    let mut first_error = String::new();
    let mut get_us = Vec::with_capacity(gets);
    let mut put_us = Vec::with_capacity(puts);
    let mut client = match OwnerClient::connect(socket)
        .and_then(|mut c| c.ping().map(|_| c).map_err(std::io::Error::other))
    {
        Ok(c) => c,
        Err(e) => {
            println!("{}", json!({"ok": false, "message": e.to_string()}));
            return 1;
        }
    };
    let mut rng = Rng::new(seed);
    let mut note_err = |e: String| {
        errors += 1;
        if first_error.is_empty() {
            first_error = e;
        }
    };
    for _ in 0..gets {
        let (s, slug) = &keys[rng.below(keys.len().max(1)) % keys.len().max(1)];
        let t = Instant::now();
        match client.get_page(s, slug) {
            Ok(Some(_)) => get_us.push(t.elapsed().as_micros() as u64),
            Ok(None) => note_err(format!("page {s}/{slug} not found")),
            Err(e) => note_err(e),
        }
    }
    for i in 0..puts {
        let slug = format!("owner/{seed}-{i}");
        let page = synth_page(0, "bench-owner", &slug);
        let chunks = random_chunks(&mut rng, 4);
        let t = Instant::now();
        match client.put_page(&page, &chunks) {
            Ok(_) => put_us.push(t.elapsed().as_micros() as u64),
            Err(e) => note_err(e),
        }
    }
    println!(
        "{}",
        json!({"ok": true, "get_us": get_us, "put_us": put_us, "errors": errors, "first_error": first_error})
    );
    0
}
