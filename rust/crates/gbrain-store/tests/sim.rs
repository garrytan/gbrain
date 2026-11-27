//! Deterministic simulation of the store on a simulated disk.
//!
//! The store runs on redb over `gbrain-sim`'s fault-injecting disk. A seed fixes everything: the
//! interleaving of three simulated clients (the `gbrain-sim` scheduler), the pages and requests
//! they write, the ids and clock the store sees, and where the disk crashes, tears a write, fails
//! an fsync or lies about one. After the crash the disk reboots, the store reopens, and the
//! recovered records are checked two ways:
//!
//! - against the commits the store acknowledged (`gbrain_sim::check::check_recovery`): nothing
//!   acknowledged is lost, and the one batch in flight at the crash is all there or not at all;
//! - against the store's own invariants (`integrity`): every page has its id index entry, every
//!   chunk its postings, the index totals match the chunks, every journal request its index entry,
//!   and the outstanding counters match the requests that have not ended.
//!
//! The logged runs (`logged_*`) open the store with the commit log on (multi-user mode,
//! `commit_log.rs`). They pin the brain's records and log position right after the open (the
//! log's activation is part of the open, so it is the baseline, not a logged change) and, after the
//! crash and the reopen, replay every record after that position onto the baseline: the result
//! must be exactly the recovered records, with the same acknowledged/in-doubt check as above
//! beside it.
//!
//! Run more seeds with `GBRAIN_SIM_SEEDS=10000`; repeat one with `GBRAIN_SIM_SEED=<n>`.
//!
//! This file drives the single-writer store only. Its crash and recovery tests are named
//! `embedded_one_owner_...`; each has a `_multi_writer` twin on the optimistic store with multi-user mode and the commit log on.
//! The twins' clients take steps one at a time on the seeded scheduler, so a commit is a batch of one; the interleaved batches
//! of the optimistic pipeline are driven through the `step_pipeline()` seam in `tests/multi_writer_sim.rs`.

mod common;

use gbrain_sim::check::{self, Class, Committed, Model, Reopen, Violation, WriteSet};
use gbrain_sim::trace::fnv1a;
use gbrain_sim::{
    CrashMode, Cx, FaultPlan, Scheduler, SimDisk, SimFile, SimRng, Step, Task, seed::seeds,
};
use gbrain_store::chunks::{ChunkInput, tokenize};
use gbrain_store::commit_log::{self, CommitPosition};
use gbrain_store::env::uuid_from_bytes;
use gbrain_store::journal::{FinishWrite, PageMutation, Principal, WriteAdmission};
use gbrain_store::kv::{read_i64, scan_prefix};
use gbrain_store::links::{
    AddLinkOptions, LinkBatchInput, LinkScope, RemoveLinkOptions, TraverseGraphOptions,
};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::timeline::{
    AddTimelineOptions, TimelineBatchInput, TimelineInput, TimelineOptions,
};
use gbrain_store::{
    Env, FileBackend, Kv, KvRead, KvWrite, MultiUserWrites, OpenOptions, Store, StoreError, keys,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

const FILE: &str = "brain.redb";
/// Steps (one store call each) a run takes across its clients.
const STEPS: usize = 48;
const CLIENTS: usize = 3;

// ---- the disk under redb ---------------------------------------------------------------------

#[derive(Debug)]
struct SimBackend(SimFile);

impl FileBackend for SimBackend {
    fn size(&self) -> std::io::Result<u64> {
        self.0.len()
    }
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        self.0.read_at(offset, out)
    }
    fn write_at(&self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        self.0.write_at(offset, data)
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.0.set_len(len)
    }
    fn sync(&self) -> std::io::Result<()> {
        self.0.sync()
    }
}

/// The record file on the simulated disk: redb alone (one writer), or under the optimistic commit pipeline.
fn open_kv(disk: &SimDisk, optimistic: bool) -> Result<Arc<dyn Kv>, StoreError> {
    let kv = RedbKv::open_backend(Box::new(SimBackend(disk.open(FILE))))?;
    if optimistic {
        return Ok(Arc::new(OccKv::new(kv)?));
    }
    Ok(Arc::new(kv))
}

/// What a run opens: the single-writer store, the single-writer store with the commit log on (multi-user mode), or the
/// optimistic store with multi-user mode and the log on (the multi-writer twins).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Flavor {
    logged: bool,
    optimistic: bool,
}

const PLAIN: Flavor = Flavor {
    logged: false,
    optimistic: false,
};
const LOGGED: Flavor = Flavor {
    logged: true,
    optimistic: false,
};
/// Multi-user mode and the log on, on the optimistic record file.
const OPTIMISTIC: Flavor = Flavor {
    logged: true,
    optimistic: true,
};

// ---- time and ids from the seed --------------------------------------------------------------

struct SimEnv {
    rng: Mutex<SimRng>,
    now: AtomicI64,
}

impl SimEnv {
    fn new(seed: u64) -> Self {
        Self {
            rng: Mutex::new(SimRng::new(seed)),
            now: AtomicI64::new(1_800_000_000_000_000),
        }
    }
}

impl Env for SimEnv {
    fn now_micros(&self) -> i64 {
        self.now.fetch_add(1_000, Ordering::Relaxed)
    }
    fn new_uuid(&self) -> String {
        rand_uuid(&mut self.rng.lock().unwrap())
    }
}

fn rand_uuid(rng: &mut SimRng) -> String {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&rng.next_u64().to_be_bytes());
    bytes[8..].copy_from_slice(&rng.next_u64().to_be_bytes());
    uuid_from_bytes(bytes)
}

// ---- what the store committed ----------------------------------------------------------------

/// The commits the store acknowledged, and the one whose acknowledgement never came.
struct Log {
    committed: Vec<Committed>,
    in_doubt: Vec<Committed>,
    last: u64,
}

struct RecKv {
    inner: Arc<dyn Kv>,
    log: Arc<Mutex<Log>>,
}

impl Kv for RecKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>, StoreError> {
        self.inner.snapshot()
    }
    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64), StoreError> {
        self.inner.versioned_snapshot()
    }
    fn begin_write(&self) -> Result<Box<dyn KvWrite>, StoreError> {
        Ok(Box::new(RecWrite {
            inner: self.inner.begin_write()?,
            log: self.log.clone(),
            writes: Vec::new(),
        }))
    }
    fn version(&self) -> Result<u64, StoreError> {
        self.inner.version()
    }
    fn enable_commit_log(&self, settings: commit_log::LogSettings) -> Result<(), StoreError> {
        self.inner.enable_commit_log(settings)
    }
    fn commit_log_enabled(&self) -> bool {
        self.inner.commit_log_enabled()
    }
    fn set_commit_clock(
        &self,
        clock: Arc<dyn Env>,
        hook: Option<commit_log::AcceptHook>,
    ) -> Result<(), StoreError> {
        self.inner.set_commit_clock(clock, hook)
    }
    fn last_commit_time(&self) -> Result<Option<i64>, StoreError> {
        self.inner.last_commit_time()
    }
    fn clear_commit_clock(&self) {
        self.inner.clear_commit_clock();
    }
}

struct RecWrite {
    inner: Box<dyn KvWrite>,
    log: Arc<Mutex<Log>>,
    writes: WriteSet,
}

impl KvRead for RecWrite {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.inner.get(key)
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<(), StoreError> {
        self.inner.scan(start, end, reverse, f)
    }
}

impl KvWrite for RecWrite {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<(), StoreError> {
        self.inner.put(key, value)?;
        // The log's own keys are its upkeep, checked by the logged runs, not records.
        if !commit_log::is_log_key(key) {
            self.writes.push((key.to_vec(), Some(value.to_vec())));
        }
        Ok(())
    }
    fn delete(&mut self, key: &[u8]) -> Result<(), StoreError> {
        self.inner.delete(key)?;
        if !commit_log::is_log_key(key) {
            self.writes.push((key.to_vec(), None));
        }
        Ok(())
    }
    fn set_commit_meta(&mut self, meta: commit_log::CommitMeta) {
        self.inner.set_commit_meta(meta);
    }
    fn set_commit_time(&mut self, time: i64) {
        self.inner.set_commit_time(time);
    }
    fn commit(self: Box<Self>) -> Result<u64, StoreError> {
        let RecWrite { inner, log, writes } = *self;
        let outcome = inner.commit();
        let mut log = log.lock().unwrap();
        match &outcome {
            // A write that changed nothing commits without a new sequence on the optimistic store (it reports the version it saw):
            // not a commit to record.
            Ok(version) if writes.is_empty() && *version <= log.last => {}
            Ok(version) => {
                log.committed.push(Committed {
                    snapshot: version.saturating_sub(1),
                    version: *version,
                    reads: Vec::new(),
                    writes,
                });
                log.last = *version;
            }
            Err(_) if log.in_doubt.is_empty() => {
                let last = log.last;
                let version = last + 1;
                log.in_doubt.push(Committed {
                    snapshot: last,
                    version,
                    reads: Vec::new(),
                    writes,
                });
            }
            Err(_) => {}
        }
        outcome
    }
}

// ---- the workload ----------------------------------------------------------------------------

const JOURNALED: [&str; 6] = [
    "notes/alpha",
    "notes/beta",
    "people/gamma",
    "people/delta",
    "projects/epsilon",
    "Projects/Zeta",
];
/// Pages that only direct writes touch, so `delete_page` never removes a page a committed journal
/// request names.
const SCRATCH: [&str; 3] = ["scratch/one", "scratch/two", "scratch/three"];
const LINK_TYPES: [&str; 3] = ["", "cites", "works_at"];
const WORDS: [&str; 12] = [
    "alpha", "beta", "gamma", "delta", "ledger", "harbor", "quartz", "meridian", "orchid",
    "falcon", "ember", "cobalt",
];

fn pick<'a>(rng: &mut SimRng, items: &[&'a str]) -> &'a str {
    items[rng.below(items.len())]
}

fn any_slug(rng: &mut SimRng) -> &'static str {
    let all: Vec<&'static str> = JOURNALED.iter().chain(SCRATCH.iter()).copied().collect();
    all[rng.below(all.len())]
}

fn body(rng: &mut SimRng, long: bool) -> String {
    let n = if long {
        250 + rng.below(300)
    } else {
        1 + rng.below(10)
    };
    let mut text = String::new();
    for i in 0..n {
        if i > 0 {
            text.push_str(if long && i % 70 == 0 { "\n\n" } else { " " });
        }
        text.push_str(pick(rng, &WORDS));
    }
    text
}

fn app() -> Principal {
    Principal {
        kind: "application".into(),
        id: "app-1".into(),
    }
}

struct World {
    store: Store,
    left: usize,
    stopped: Option<String>,
    history: Vec<(PageMutation, Value)>,
    outstanding: Vec<String>,
    violations: Vec<Violation>,
}

struct Client(String);

fn json_of<T: serde::Serialize>(r: Result<T, StoreError>) -> Result<Value, StoreError> {
    r.map(|v| serde_json::to_value(v).unwrap())
}

impl World {
    fn run_op(&mut self, rng: &mut SimRng) -> (String, Result<Value, StoreError>) {
        let roll = rng.below(100);
        let scope = ReadScope::default();
        match roll {
            0..=29 => {
                let slug = pick(rng, &JOURNALED);
                let request = rand_uuid(rng);
                let long = rng.below(4) == 0;
                let text = body(rng, long);
                let options = match rng.below(10) {
                    0 => json!({"expectedRevision": rand_uuid(rng)}),
                    1 => json!({"force": false}),
                    2..=3 => match self.store.read_page_snapshot(slug, &scope) {
                        Ok(Some(page)) => json!({"expectedRevision": page["revision"]}),
                        _ => json!({}),
                    },
                    _ => json!({}),
                };
                let mutation: PageMutation = serde_json::from_value(json!({
                    "principal": {"kind": "local_cli", "id": "writer-1"},
                    "requestId": request,
                    "slug": slug,
                    "page": {"type": "note", "title": slug, "compiled_truth": text},
                    "options": options,
                }))
                .unwrap();
                let result = self.store.submit_page_mutation(&mutation, None);
                if let Ok(receipt) = &result {
                    self.history.push((mutation, receipt.clone()));
                }
                ("submit".into(), result)
            }
            30..=37 => {
                if self.history.is_empty() {
                    return ("replay-none".into(), Ok(Value::Null));
                }
                let (mutation, first) = self.history[rng.below(self.history.len())].clone();
                let result = self.store.submit_page_mutation(&mutation, None);
                if let Ok(again) = &result
                    && again != &first
                {
                    self.violations.push(Violation {
                        class: Class::Corrupt,
                        message: format!(
                            "repeating request {:?} changed its receipt",
                            mutation.request_id
                        ),
                    });
                }
                ("replay".into(), result)
            }
            38..=45 => {
                let slug = any_slug(rng);
                let long = rng.below(4) == 0;
                let input: PageInput = serde_json::from_value(
                    json!({"type": "note", "title": slug, "compiled_truth": body(rng, long)}),
                )
                .unwrap();
                (
                    "put".into(),
                    self.store
                        .put_page(slug, &input, &PutPageOptions::default()),
                )
            }
            46..=50 => {
                let slug = any_slug(rng);
                let tag = pick(rng, &["red", "green", "blue"]);
                if rng.below(3) == 0 {
                    (
                        "untag".into(),
                        json_of(self.store.remove_tag(slug, tag, None)),
                    )
                } else {
                    ("tag".into(), json_of(self.store.add_tag(slug, tag, None)))
                }
            }
            51..=55 => {
                let slug = any_slug(rng);
                if rng.below(2) == 0 {
                    (
                        "soft-delete".into(),
                        json_of(self.store.soft_delete_page(slug, None)),
                    )
                } else {
                    (
                        "restore".into(),
                        json_of(self.store.restore_page(slug, None)),
                    )
                }
            }
            56..=59 => {
                let slug = pick(rng, &SCRATCH);
                ("delete".into(), json_of(self.store.delete_page(slug, None)))
            }
            60..=66 => {
                let slug = any_slug(rng);
                let Ok(Some(page)) = self.store.read_page_snapshot(slug, &scope) else {
                    return ("chunks-skip".into(), Ok(Value::Null));
                };
                let chunks: Vec<ChunkInput> = serde_json::from_value(json!([
                    {"chunk_index": 0, "chunk_text": body(rng, false), "chunk_source": "compiled_truth"},
                    {"chunk_index": 1, "chunk_text": body(rng, false), "chunk_source": "timeline"},
                ]))
                .unwrap();
                let options =
                    serde_json::from_value(json!({"expectedRevision": page["revision"]})).unwrap();
                (
                    "chunks".into(),
                    json_of(self.store.upsert_chunks(slug, &chunks, &options)),
                )
            }
            67..=70 => {
                let slug = any_slug(rng);
                ("version".into(), self.store.create_version(slug, None))
            }
            71..=76 => {
                let request = rand_uuid(rng);
                let admission: WriteAdmission = serde_json::from_value(json!({
                    "principal": {"kind": "application", "id": "app-1"},
                    "operation": "put_page",
                    "requestId": request,
                    "slug": pick(rng, &JOURNALED),
                    "callerIntent": {"n": rng.below(1000)},
                }))
                .unwrap();
                let result = self.store.admit_write(&admission, None);
                if result.is_ok() {
                    self.outstanding.push(request);
                }
                ("admit".into(), result)
            }
            83..=91 => self.link_op(rng),
            92..=99 => self.timeline_op(rng),
            _ => {
                if self.outstanding.is_empty() {
                    return ("finish-none".into(), Ok(Value::Null));
                }
                let request = self
                    .outstanding
                    .swap_remove(rng.below(self.outstanding.len()));
                let finish: FinishWrite = serde_json::from_value(json!({
                    "state": pick(rng, &["committed", "failed", "cancelled", "conflict"]),
                    "outcome": {"note": "finished by the simulation"},
                }))
                .unwrap();
                (
                    "finish".into(),
                    self.store.finish_write(&app(), &request, &finish),
                )
            }
        }
    }

    /// A link write (add, batch add, remove) or a graph read between any of the pages, so
    /// links reach soft-deleted and deleted pages and `delete_page` cascades over them.
    fn link_op(&mut self, rng: &mut SimRng) -> (String, Result<Value, StoreError>) {
        let (from, to) = (any_slug(rng), any_slug(rng));
        let link_type = pick(rng, &LINK_TYPES);
        let link_source = pick(rng, &["markdown", "manual", "frontmatter"]);
        match rng.below(8) {
            0..=2 => {
                let mut options = json!({
                    "context": body(rng, false),
                    "linkType": link_type,
                    "linkSource": link_source,
                });
                if link_source == "frontmatter" {
                    options["originSlug"] = json!(any_slug(rng));
                    options["originField"] = json!(link_type);
                }
                let options: AddLinkOptions = serde_json::from_value(options).unwrap();
                (
                    "link".into(),
                    json_of(self.store.add_link(from, to, &options)),
                )
            }
            3 => {
                let links: Vec<LinkBatchInput> = (0..1 + rng.below(4))
                    .map(|_| {
                        serde_json::from_value(json!({
                            "from_slug": any_slug(rng),
                            "to_slug": any_slug(rng),
                            "link_type": pick(rng, &LINK_TYPES),
                            "link_source": "markdown",
                        }))
                        .unwrap()
                    })
                    .collect();
                (
                    "link-batch".into(),
                    json_of(self.store.add_links_batch(&links)),
                )
            }
            4..=5 => {
                let options: RemoveLinkOptions = serde_json::from_value(match rng.below(3) {
                    0 => json!({}),
                    1 => json!({"linkType": link_type}),
                    _ => json!({"linkType": link_type, "linkSource": link_source}),
                })
                .unwrap();
                (
                    "unlink".into(),
                    json_of(self.store.remove_link(from, to, &options)),
                )
            }
            6 => {
                let depth = 1 + rng.below(3) as i64;
                let options = TraverseGraphOptions::default();
                (
                    "walk".into(),
                    json_of(self.store.traverse_graph(from, Some(depth), &options)),
                )
            }
            _ => (
                "backlinks".into(),
                json_of(self.store.get_backlinks(to, &LinkScope::default())),
            ),
        }
    }

    /// A timeline write (one entry or a batch, duplicates included) or a timeline read.
    fn timeline_op(&mut self, rng: &mut SimRng) -> (String, Result<Value, StoreError>) {
        let slug = any_slug(rng);
        let entry = |rng: &mut SimRng| {
            json!({
                "date": format!("2026-0{}-1{}", 1 + rng.below(3), rng.below(3)),
                "summary": pick(rng, &WORDS),
                "source": pick(rng, &["", "cal", "mail"]),
            })
        };
        match rng.below(5) {
            0..=2 => {
                let input: TimelineInput = serde_json::from_value(entry(rng)).unwrap();
                (
                    "timeline".into(),
                    json_of(self.store.add_timeline_entry(
                        slug,
                        &input,
                        &AddTimelineOptions::default(),
                    )),
                )
            }
            3 => {
                let entries: Vec<TimelineBatchInput> = (0..1 + rng.below(4))
                    .map(|_| {
                        let mut e = entry(rng);
                        e["slug"] = json!(any_slug(rng));
                        serde_json::from_value(e).unwrap()
                    })
                    .collect();
                (
                    "timeline-batch".into(),
                    json_of(self.store.add_timeline_entries_batch(&entries)),
                )
            }
            _ => (
                "timeline-read".into(),
                json_of(self.store.get_timeline(slug, &TimelineOptions::default())),
            ),
        }
    }
}

impl Task<World> for Client {
    fn name(&self) -> &str {
        &self.0
    }
    fn ready(&self, world: &World) -> bool {
        world.left > 0 && world.stopped.is_none()
    }
    fn step(&mut self, world: &mut World, cx: &mut Cx<'_>) -> Step {
        world.left -= 1;
        let (label, result) = world.run_op(cx.rng);
        match result {
            Ok(value) => cx.trace.event(&format!(
                "{label} ok {:016x}",
                fnv1a(value.to_string().as_bytes())
            )),
            Err(e) => {
                cx.trace.event(&format!("{label} err {}", e.code));
                // A failure of the store itself ends the run: the disk is gone or faulted.
                if e.code.starts_with("store_") {
                    world.stopped = Some(format!("{label}: {e}"));
                }
            }
        }
        Step::Continue
    }
}

struct Run {
    log: Arc<Mutex<Log>>,
    kv: Arc<dyn Kv>,
    /// Logged runs: the records and the log position right after the open.
    baseline: Option<(Model, CommitPosition)>,
    violations: Vec<Violation>,
    trace_hash: u64,
    /// I/O calls the disk had counted when the store was ready (the crash point is after them).
    setup_ops: u64,
    stopped: Option<String>,
}

/// Open the store on `disk`, apply `plan` once it is ready, and drive the seeded clients.
fn workload(disk: &SimDisk, seed: u64, plan: Option<FaultPlan>) -> Result<Run, StoreError> {
    workload_as(disk, seed, plan, PLAIN)
}

/// The options of a logged run: the commit log on, with a host id for the write origin; `optimistic` puts the store on the
/// concurrent-write record file (`concurrent_writes`).
fn logged_options(optimistic: bool) -> OpenOptions {
    OpenOptions {
        concurrent_writes: optimistic,
        multiuser: true,
        multiuser_writes: MultiUserWrites {
            commit_log: true,
            write_origin: true,
            host_id: Some("d0000000-0000-4000-8000-0000000000d1".into()),
            log_retention_bytes: None,
        },
        ..OpenOptions::default()
    }
}

fn workload_as(
    disk: &SimDisk,
    seed: u64,
    plan: Option<FaultPlan>,
    flavor: Flavor,
) -> Result<Run, StoreError> {
    let kv = open_kv(disk, flavor.optimistic)?;
    let log = Arc::new(Mutex::new(Log {
        committed: Vec::new(),
        in_doubt: Vec::new(),
        last: kv.version()?,
    }));
    let recording: Arc<dyn Kv> = Arc::new(RecKv {
        inner: kv.clone(),
        log: log.clone(),
    });
    let store = Store::open_kv(
        recording,
        Arc::new(SimEnv::new(seed ^ 0xE4E)),
        if flavor.logged {
            logged_options(flavor.optimistic)
        } else {
            OpenOptions::default()
        },
    )?;
    if flavor.logged {
        // Multi-user mode and the log on, in the run and asserted: a run that lost the switch fails here, never passes as a plain one.
        common::mu::assert_logged(&store);
    }
    let baseline = if flavor.logged {
        let read = kv.snapshot()?;
        let meta = commit_log::read_meta(&*read)?.expect("a logged run's brain keeps a log");
        Some((data_of(&*read)?, meta.newest))
    } else {
        None
    };
    let setup_ops = disk.stats().io_ops;
    if let Some(plan) = plan {
        disk.set_plan(plan);
    }
    let mut world = World {
        store,
        left: STEPS,
        stopped: None,
        history: Vec::new(),
        outstanding: Vec::new(),
        violations: Vec::new(),
    };
    let mut scheduler = Scheduler::new(seed);
    for i in 0..CLIENTS {
        scheduler.spawn(Box::new(Client(format!("client-{i}"))));
    }
    scheduler.run(&mut world, u64::MAX, |_| false);
    Ok(Run {
        log,
        kv,
        baseline,
        violations: world.violations,
        trace_hash: scheduler.trace.hash(),
        setup_ops,
        stopped: world.stopped,
    })
}

// ---- the store's own invariants --------------------------------------------------------------

type Entry = (Vec<u8>, Vec<u8>);

fn entries(read: &dyn KvRead, tag: u8) -> Result<Vec<Entry>, StoreError> {
    let mut out = Vec::new();
    scan_prefix(read, &[tag], false, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        true
    })?;
    Ok(out)
}

fn record(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

fn read_state(kv: &dyn Kv) -> Result<Model, StoreError> {
    data_of(&*kv.snapshot()?)
}

/// Every record of `read` but the commit log's own (a brain opened with the log off has none).
fn data_of(read: &dyn KvRead) -> Result<Model, StoreError> {
    let mut model = Model::new();
    read.scan(&[1], &[0xFF], false, &mut |k, v| {
        if !commit_log::is_log_key(k) {
            model.insert(k.to_vec(), v.to_vec());
        }
        true
    })?;
    Ok(model)
}

/// A logged run's log check: every record after the baseline position, applied to the baseline
/// in order, gives exactly the records `kv` holds. A gap, a record whose data is missing or data
/// whose record is missing shows up as a difference.
///
/// `optimistic`: the optimistic store logs blind counter adds (`AddI64`: the delta, 8 bytes little-endian, onto a counter stored the
/// same way, absent as 0), which the replay applies; the single-writer store never logs one, and a run that finds one fails.
fn check_log_replay(
    kv: &dyn Kv,
    baseline: &(Model, CommitPosition),
    optimistic: bool,
) -> Result<(), String> {
    let read = kv.snapshot().map_err(|e| e.to_string())?;
    let (start, cursor) = baseline;
    let page = commit_log::read_commit_log(&*read, Some(*cursor), usize::MAX)
        .map_err(|e| format!("reading the log: {e}"))?;
    if page.snapshot_required {
        return Err("the log no longer reaches back to the baseline".into());
    }
    let mut model = start.clone();
    let mut prev = *cursor;
    let mut prev_time: Option<i64> = None;
    for record in &page.records {
        if prev_time.is_some_and(|t| record.commit_time <= t) {
            return Err(format!(
                "commit time goes back at {}",
                record.position.token()
            ));
        }
        prev_time = Some(record.commit_time);
        if !record.position.follows(prev) {
            return Err(format!(
                "the log jumps from {} to {}",
                prev.token(),
                record.position.token()
            ));
        }
        prev = record.position;
        for (key, op) in &record.ops {
            match op {
                commit_log::LogOp::Put(v) => {
                    model.insert(key.clone(), v.clone());
                }
                commit_log::LogOp::Delete => {
                    model.remove(key);
                }
                commit_log::LogOp::RaiseCounter(m) => {
                    let base = model
                        .get(key)
                        .and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok())
                        .map(u64::from_be_bytes)
                        .unwrap_or(0);
                    model.insert(key.clone(), base.max(*m).to_be_bytes().to_vec());
                }
                commit_log::LogOp::AddI64(delta) if optimistic => {
                    let base = model
                        .get(key)
                        .and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok())
                        .map(i64::from_le_bytes)
                        .unwrap_or(0);
                    model.insert(
                        key.clone(),
                        base.wrapping_add(*delta).to_le_bytes().to_vec(),
                    );
                }
                other => return Err(format!("the single-writer store logged {other:?}")),
            }
        }
    }
    if let Some(t) = prev_time {
        let durable = kv.last_commit_time().map_err(|e| e.to_string())?;
        if durable != Some(t) {
            return Err(format!(
                "the newest record's time is {t}, the durable time {durable:?}"
            ));
        }
    }
    let version = kv.version().map_err(|e| e.to_string())?;
    if prev.sequence != version {
        return Err(format!(
            "the log ends at {}, the store at sequence {version}",
            prev.token()
        ));
    }
    let stored = data_of(&*read).map_err(|e| e.to_string())?;
    if stored != model {
        let differ: Vec<String> = stored
            .keys()
            .chain(model.keys())
            .filter(|k| stored.get(*k) != model.get(*k))
            .take(3)
            .map(|k| k.escape_ascii().to_string())
            .collect();
        return Err(format!(
            "the log replays to other records than the store holds: {differ:?}"
        ));
    }
    Ok(())
}

/// Everything the store promises about its records that a crash must not break. Empty when sound.
fn integrity(kv: &dyn Kv) -> Result<Vec<String>, StoreError> {
    let read = kv.snapshot()?;
    let read = &*read;
    let mut bad = Vec::new();

    // pages and the id index
    let mut pages: BTreeMap<u64, Value> = BTreeMap::new();
    for (key, value) in entries(read, keys::PAGE)? {
        let page = record(&value);
        let id = page["id"].as_u64().unwrap_or(0);
        let expected = keys::page(
            page["source_id"].as_str().unwrap_or(""),
            page["slug"].as_str().unwrap_or(""),
        );
        if key != expected {
            bad.push(format!("page {id} is stored under the wrong key"));
        }
        if read.get(&keys::page_id(id))? != Some(key) {
            bad.push(format!("page {id} has no id index entry"));
        }
        pages.insert(id, page);
    }
    for (key, value) in entries(read, keys::PAGE_ID)? {
        let id = keys::be8(&key[1..]).unwrap_or(0);
        match read.get(&value)? {
            Some(page) if record(&page)["id"].as_u64() == Some(id) => {}
            _ => bad.push(format!(
                "id index entry {id} names a page that is not there"
            )),
        }
    }

    // chunks, postings and the index totals
    let mut expected_postings: BTreeMap<(String, u64, u32), u32> = BTreeMap::new();
    let (mut chunk_count, mut total_length) = (0u64, 0u64);
    for (key, value) in entries(read, keys::CHUNK)? {
        let (page_id, index) = (
            keys::be8(&key[1..9]).unwrap_or(0),
            keys::be4(&key[9..13]).unwrap_or(0),
        );
        let chunk = record(&value);
        if chunk["page_id"].as_u64() != Some(page_id)
            || chunk["chunk_index"].as_u64() != Some(u64::from(index))
        {
            bad.push(format!("chunk {page_id}/{index} disagrees with its key"));
        }
        if !pages.contains_key(&page_id) {
            bad.push(format!(
                "chunk {page_id}/{index} belongs to a page that is not there"
            ));
        }
        let terms = tokenize(chunk["chunk_text"].as_str().unwrap_or(""));
        if chunk["length"].as_u64() != Some(terms.len() as u64) {
            bad.push(format!("chunk {page_id}/{index} has the wrong length"));
        }
        chunk_count += 1;
        total_length += terms.len() as u64;
        for term in terms {
            *expected_postings.entry((term, page_id, index)).or_insert(0) += 1;
        }
    }
    let mut postings: BTreeMap<(String, u64, u32), u32> = BTreeMap::new();
    for (key, value) in entries(read, keys::POSTING)? {
        let Some(split) = key[1..].iter().position(|b| *b == 0).map(|i| i + 1) else {
            bad.push("a posting key has no separator".into());
            continue;
        };
        let rest = &key[split + 1..];
        let term = String::from_utf8_lossy(&key[1..split]).into_owned();
        let count = <[u8; 4]>::try_from(value.as_slice())
            .map(u32::from_be_bytes)
            .unwrap_or(0);
        if rest.len() != 12 {
            bad.push(format!("posting {term:?} has a malformed key"));
            continue;
        }
        postings.insert(
            (
                term,
                keys::be8(&rest[..8]).unwrap_or(0),
                keys::be4(&rest[8..]).unwrap_or(0),
            ),
            count,
        );
    }
    if postings != expected_postings {
        bad.push(format!(
            "the postings ({}) do not match the chunk text ({})",
            postings.len(),
            expected_postings.len()
        ));
    }
    // The legacy JSON record plus the per-counter records written since the concurrent store.
    let mut stats = read
        .get(&keys::meta("chunk_stats"))?
        .map(|b| record(&b))
        .unwrap_or_else(|| json!({"chunks": 0, "total_length": 0}));
    for (name, field) in [
        ("chunk_stats/chunks", "chunks"),
        ("chunk_stats/total_length", "total_length"),
    ] {
        let add = read_i64(read, &keys::meta(name))?;
        let sum = stats[field].as_i64().unwrap_or(0) + add;
        stats[field] = json!(sum);
    }
    if stats["chunks"].as_u64() != Some(chunk_count)
        || stats["total_length"].as_u64() != Some(total_length)
    {
        bad.push(format!(
            "chunk_stats {stats} is not the real totals ({chunk_count}, {total_length})"
        ));
    }

    // versions belong to a page
    for (key, value) in entries(read, keys::VERSION)? {
        let page_id = keys::be8(&key[1..9]).unwrap_or(0);
        if !pages.contains_key(&page_id) || record(&value)["page_id"].as_u64() != Some(page_id) {
            bad.push(format!("a version of page {page_id} has no page"));
        }
    }

    // links: the record under its from page, and its three index keys
    let mut link_index: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
    for (key, value) in entries(read, keys::LINK)? {
        let link = record(&value);
        let (id, from, to) = (
            link["id"].as_u64().unwrap_or(0),
            link["from_page_id"].as_u64().unwrap_or(0),
            link["to_page_id"].as_u64().unwrap_or(0),
        );
        let origin = link["origin_page_id"].as_u64();
        if key != keys::link(from, id) {
            bad.push(format!("link {id} is stored under the wrong key"));
        }
        for (end, page) in [("from", Some(from)), ("to", Some(to)), ("origin", origin)] {
            if let Some(page) = page
                && !pages.contains_key(&page)
            {
                bad.push(format!(
                    "link {id} has a {end} page {page} that is not there"
                ));
            }
        }
        let unique = keys::link_unique(
            from,
            to,
            link["link_type"].as_str().unwrap_or(""),
            link["link_source"].as_str(),
            origin,
        );
        let mut expect = vec![
            (keys::link_to(to, id), from.to_be_bytes().to_vec()),
            (unique, id.to_be_bytes().to_vec()),
        ];
        if let Some(origin) = origin {
            expect.push((keys::link_origin(origin, id), from.to_be_bytes().to_vec()));
        }
        for (index, want) in expect {
            if read.get(&index)?.as_ref() != Some(&want) {
                bad.push(format!(
                    "link {id} is missing the index key {:?}",
                    index[0] as char
                ));
            }
            link_index.insert(index, want);
        }
    }
    for tag in [keys::LINK_TO, keys::LINK_UNIQUE, keys::LINK_ORIGIN] {
        for (key, value) in entries(read, tag)? {
            if link_index.get(&key) != Some(&value) {
                bad.push(format!("a {:?} link index key names no link", tag as char));
            }
        }
    }

    // timeline: the entry under its page and date, its dedup key, and the page's newest time
    let mut dedup_index: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
    let mut newest: BTreeMap<u64, i64> = BTreeMap::new();
    for (key, value) in entries(read, keys::TIMELINE)? {
        let entry = record(&value);
        let (id, page_id) = (
            entry["id"].as_u64().unwrap_or(0),
            entry["page_id"].as_u64().unwrap_or(0),
        );
        let date = entry["date"].as_str().unwrap_or("");
        if key != keys::timeline(page_id, date, id) {
            bad.push(format!("timeline entry {id} is stored under the wrong key"));
        }
        if !pages.contains_key(&page_id) {
            bad.push(format!(
                "timeline entry {id} belongs to a page that is not there"
            ));
        }
        let digest: [u8; 32] =
            Sha256::digest(entry["summary"].as_str().unwrap_or("").as_bytes()).into();
        let dedup = keys::timeline_dedup(
            page_id,
            date,
            &digest,
            entry["source"].as_str().unwrap_or(""),
        );
        if read.get(&dedup)? != Some(id.to_be_bytes().to_vec()) {
            bad.push(format!("timeline entry {id} has no dedup key"));
        }
        dedup_index.insert(dedup, id.to_be_bytes().to_vec());
        let created = entry["created_at_us"].as_i64().unwrap_or(i64::MIN);
        let max = newest.entry(page_id).or_insert(i64::MIN);
        *max = (*max).max(created);
    }
    for (key, value) in entries(read, keys::TIMELINE_DEDUP)? {
        if dedup_index.get(&key) != Some(&value) {
            bad.push("a timeline dedup key names no entry".into());
        }
    }
    let mut latest: BTreeMap<u64, i64> = BTreeMap::new();
    for (key, value) in entries(read, keys::TIMELINE_LATEST)? {
        let page_id = keys::be8(&key[1..]).unwrap_or(0);
        let micros = <[u8; 8]>::try_from(value.as_slice())
            .map(i64::from_be_bytes)
            .unwrap_or(i64::MIN);
        latest.insert(page_id, micros);
    }
    if latest != newest {
        bad.push(format!(
            "the newest-entry times {latest:?} are not the entries' newest created_at {newest:?}"
        ));
    }

    // journal
    let mut open_total = 0u64;
    let mut open_by_principal: BTreeMap<String, u64> = BTreeMap::new();
    let mut max_sequence = 0u64;
    let mut ids = Vec::new();
    for (_, value) in entries(read, keys::REQUEST)? {
        let request = record(&value);
        let id = request["id"].as_str().unwrap_or("").to_string();
        let (kind, principal, request_id) = (
            request["principal_kind"].as_str().unwrap_or(""),
            request["principal_id"].as_str().unwrap_or(""),
            request["request_id"].as_str().unwrap_or(""),
        );
        if read.get(&keys::request_by_principal(kind, principal, request_id))?
            != Some(id.clone().into_bytes())
        {
            bad.push(format!(
                "request {request_id} has no idempotency index entry"
            ));
        }
        let state = request["state"].as_str().unwrap_or("");
        if !["committed", "conflict", "failed", "cancelled"].contains(&state) {
            open_total += 1;
            *open_by_principal
                .entry(format!("principal:{kind}:{principal}"))
                .or_insert(0) += 1;
        }
        if state == "committed"
            && request["operation"] == "put_page"
            && let Some(page_id) = request["outcome"]["page_id"].as_u64()
            && !pages.contains_key(&page_id)
        {
            bad.push(format!(
                "request {request_id} committed page {page_id}, which is not there"
            ));
        }
        max_sequence = max_sequence.max(request["sequence"].as_u64().unwrap_or(0));
        ids.push(id);
    }
    for (key, value) in entries(read, keys::REQUEST_ID)? {
        let id = String::from_utf8_lossy(&value).into_owned();
        if !ids.contains(&id) {
            bad.push(format!(
                "idempotency index entry {:?} names no request",
                String::from_utf8_lossy(&key)
            ));
        }
    }
    let mut counters = read
        .get(&keys::meta("journal_counters"))?
        .map(|b| record(&b))
        .unwrap_or_else(|| json!({"brain": 0, "principals": {}}));
    // The legacy JSON record plus the per-counter records written since the concurrent store.
    let brain = counters["brain"].as_i64().unwrap_or(0)
        + read_i64(read, &keys::meta("journal_outstanding"))?;
    counters["brain"] = json!(brain);
    let mut outstanding = Vec::new();
    scan_prefix(
        read,
        &keys::meta("journal_outstanding/"),
        false,
        &mut |k, v| {
            outstanding.push((k.to_vec(), v.to_vec()));
            true
        },
    )?;
    for (key, value) in outstanding {
        let name =
            String::from_utf8_lossy(&key[keys::meta("journal_outstanding/").len()..]).into_owned();
        let add = i64::from_le_bytes(value.as_slice().try_into().unwrap_or([0; 8]));
        if !counters["principals"].is_object() {
            counters["principals"] = json!({});
        }
        let sum = counters["principals"][&name].as_i64().unwrap_or(0) + add;
        if sum == 0 {
            counters["principals"]
                .as_object_mut()
                .unwrap()
                .remove(&name);
        } else {
            counters["principals"][&name] = json!(sum);
        }
    }
    if counters["brain"].as_u64() != Some(open_total) {
        bad.push(format!(
            "the brain counter {} is not the {open_total} unfinished requests",
            counters["brain"]
        ));
    }
    let recorded: BTreeMap<String, u64> = counters["principals"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_u64().unwrap_or(0)))
                .collect()
        })
        .unwrap_or_default();
    if recorded != open_by_principal {
        bad.push(format!("the principal counters {recorded:?} are not the unfinished requests {open_by_principal:?}"));
    }
    let next = read
        .get(&keys::meta("next_sequence"))?
        .and_then(|b| keys::be8(&b))
        .unwrap_or(1);
    if next <= max_sequence {
        bad.push(format!(
            "next_sequence {next} is not past the highest request sequence {max_sequence}"
        ));
    }
    Ok(bad)
}

// ---- one seed --------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// Crash points only: the disk is honest.
    Crash,
    /// Crash points plus fsync errors and fsync lies.
    FsyncFault,
    /// Negative control: every fsync lies and the crash keeps a random subset of the writes, but
    /// the checker is told the disk was honest. The checker MUST report violations here; if it
    /// does not, the harness is blind.
    Control,
}

#[derive(Default)]
struct SeedResult {
    violations: Vec<Violation>,
    commits: usize,
    crash_hit: bool,
    refused: bool,
    lost_after_lie: bool,
    in_doubt_applied: Option<bool>,
    trace_hash: u64,
    io_ops: u64,
}

fn msg(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<String>()
        .cloned()
        .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "panic".into())
}

fn corrupt(message: String) -> Violation {
    Violation {
        class: Class::Corrupt,
        message,
    }
}

/// Reopen after a crash: what recovery gave, plus anything the store's own checks found. A
/// recovered store must also take a new write.
fn reopen(
    disk: &SimDisk,
    seed: u64,
    baseline: Option<&(Model, CommitPosition)>,
    optimistic: bool,
) -> (Reopen, Vec<Violation>) {
    let mut extra = Vec::new();
    let opened = catch_unwind(AssertUnwindSafe(|| -> Result<(u64, Model), StoreError> {
        let kv = open_kv(disk, optimistic)?;
        let version = kv.version()?;
        let state = read_state(&*kv)?;
        for problem in integrity(&*kv)? {
            extra.push(corrupt(format!("after recovery: {problem}")));
        }
        if let Some(baseline) = baseline
            && let Err(problem) = check_log_replay(&*kv, baseline, optimistic)
        {
            extra.push(corrupt(format!(
                "after recovery, the commit log: {problem}"
            )));
        }
        let store = Store::open_kv(
            kv.clone(),
            Arc::new(SimEnv::new(seed ^ 0x5EED)),
            if baseline.is_some() {
                logged_options(optimistic)
            } else {
                OpenOptions::default()
            },
        )?;
        if baseline.is_some() {
            common::mu::assert_logged(&store);
        }
        let input: PageInput = serde_json::from_value(
            json!({"type": "note", "title": "after", "compiled_truth": "written after recovery"}),
        )
        .unwrap();
        match store.put_page("after/recovery", &input, &PutPageOptions::default()) {
            Ok(_) if kv.version()? == version + 1 => {}
            other => extra.push(corrupt(format!(
                "reopened at version {version} but the next write gave {:?} (version now {:?})",
                other.map(|_| ()),
                kv.version()
            ))),
        }
        for problem in integrity(&*kv)? {
            extra.push(corrupt(format!(
                "after the first write following recovery: {problem}"
            )));
        }
        if let Some(baseline) = baseline
            && let Err(problem) = check_log_replay(&*kv, baseline, optimistic)
        {
            extra.push(corrupt(format!(
                "after the first write following recovery, the commit log: {problem}"
            )));
        }
        Ok((version, state))
    }));
    let reopen = match opened {
        Ok(Ok((version, state))) => Reopen::Opened { version, state },
        Ok(Err(e)) => Reopen::Refused(e.to_string()),
        Err(p) => Reopen::Panicked(msg(p)),
    };
    (reopen, extra)
}

fn run_seed(seed: u64, kind: Kind) -> SeedResult {
    run_seed_as(seed, kind, PLAIN)
}

fn run_seed_as(seed: u64, kind: Kind, flavor: Flavor) -> SeedResult {
    let mut res = SeedResult::default();
    // Calibration: the same seed on an honest disk with no crash gives the I/O budget.
    let (setup_ops, total_ops) = {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let run = workload_as(&disk, seed, None, flavor)
            .expect("the store opens on a fresh simulated disk");
        (run.setup_ops, disk.stats().io_ops)
    };

    let salt: u64 = match kind {
        Kind::Crash => 0x51,
        Kind::FsyncFault => 0xF5,
        Kind::Control => 0xC0,
    };
    let mut rng = SimRng::new(seed ^ (salt << 56));
    let crash_at = setup_ops + 1 + rng.below((total_ops - setup_ops + 1) as usize) as u64;
    let (mut error_pm, mut lie_pm) = (0, 0);
    let mut modes = vec![
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    if kind == Kind::Control {
        lie_pm = 1000;
        modes = vec![CrashMode::Subset];
    }
    if kind == Kind::FsyncFault {
        match rng.below(3) {
            0 => error_pm = 10 + rng.below(50) as u32,
            1 => lie_pm = 100 + rng.below(300) as u32,
            _ => {
                error_pm = 10 + rng.below(30) as u32;
                lie_pm = 100 + rng.below(200) as u32;
            }
        }
        // After a lie the device lost data in order: drop or tear. Subset is fair only when
        // fsync is honest or merely errors.
        if lie_pm > 0 {
            modes.truncate(2);
        }
    }
    let mode = modes[rng.below(modes.len())];

    let disk = SimDisk::new(seed, FaultPlan::none());
    let plan = FaultPlan {
        fsync_error_pm: error_pm,
        fsync_lie_pm: lie_pm,
        crash_at_op: Some(crash_at),
        crash_mode: mode,
    };
    let ran = catch_unwind(AssertUnwindSafe(|| {
        workload_as(&disk, seed, Some(plan), flavor)
    }));
    let run = match ran {
        Ok(Ok(run)) => run,
        Ok(Err(e)) => {
            res.violations
                .push(corrupt(format!("the workload could not start: {e}")));
            return res;
        }
        Err(p) => {
            res.violations
                .push(corrupt(format!("panic during the workload: {}", msg(p))));
            return res;
        }
    };
    res.crash_hit = disk.is_crashed();
    disk.crash_now();
    let Run {
        log,
        kv,
        baseline,
        violations,
        trace_hash,
        ..
    } = run;
    drop(kv);
    let stats = disk.stats();
    let (acked, in_doubt) = {
        let log = log.lock().unwrap();
        (log.committed.clone(), log.in_doubt.clone())
    };
    res.commits = acked.len();
    res.trace_hash = trace_hash;
    res.io_ops = stats.io_ops;
    res.violations.extend(violations);

    disk.reboot();
    let (reopened, extra) = reopen(&disk, seed, baseline.as_ref(), flavor.optimistic);
    // The control tells the checker the disk was honest although it lied, so a clean refusal or
    // a lost acknowledged commit must show up as a violation.
    let lied = stats.fsync_lies > 0 && kind != Kind::Control;
    let verdict = check::check_recovery(&acked, &in_doubt, lied, &reopened);
    res.refused = verdict.refused;
    res.lost_after_lie = verdict.lost_after_lie;
    if let Reopen::Opened { version, .. } = &reopened {
        let acked_max = acked.last().map(|c| c.version).unwrap_or(0);
        res.in_doubt_applied = Some(*version > acked_max);
    }
    res.violations.extend(extra);
    res.violations.extend(verdict.violations);
    res
}

#[derive(Default)]
struct Totals {
    seeds: usize,
    commits: usize,
    crashes: usize,
    refused: usize,
    lost_after_lie: usize,
    in_doubt_applied: usize,
    by_class: BTreeMap<&'static str, usize>,
    failures: Vec<String>,
}

impl Totals {
    fn add(&mut self, seed: u64, r: &SeedResult) {
        self.seeds += 1;
        self.commits += r.commits;
        self.crashes += r.crash_hit as usize;
        self.refused += r.refused as usize;
        self.lost_after_lie += r.lost_after_lie as usize;
        self.in_doubt_applied += (r.in_doubt_applied == Some(true)) as usize;
        for v in &r.violations {
            *self.by_class.entry(v.class.name()).or_insert(0) += 1;
        }
        if !r.violations.is_empty() && self.failures.len() < 5 {
            self.failures.push(format!(
                "seed {seed}: {}",
                r.violations
                    .iter()
                    .take(3)
                    .map(|v| format!("[{}] {}", v.class.name(), v.message))
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
    }

    fn violations(&self) -> usize {
        self.by_class.values().sum()
    }

    fn print(&self, label: &str) {
        let count = |class: &str| self.by_class.get(class).copied().unwrap_or(0);
        println!(
            "{label}: {} seeds, {} commits acknowledged, {} crashes mid-run, {} refused to reopen, {} lost after a lie, {} in-doubt batches applied | lost {}, torn {}, nonserializable {}, corrupt {}",
            self.seeds,
            self.commits,
            self.crashes,
            self.refused,
            self.lost_after_lie,
            self.in_doubt_applied,
            count("lost"),
            count("torn"),
            count("nonserializable"),
            count("corrupt"),
        );
    }
}

fn run_kind(kind: Kind, default_seeds: u64, label: &str) -> Totals {
    run_kind_as(kind, default_seeds, label, PLAIN)
}

fn run_kind_as(kind: Kind, default_seeds: u64, label: &str, flavor: Flavor) -> Totals {
    let mut totals = Totals::default();
    for seed in seeds(default_seeds) {
        let result = run_seed_as(seed, kind, flavor);
        totals.add(seed, &result);
    }
    totals.print(label);
    totals
}

fn assert_clean(totals: &Totals, label: &str) {
    assert!(
        totals.violations() == 0,
        "{label}: {} violations. First: {:#?}\nrepro: GBRAIN_SIM_SEED=<seed> cargo test -p gbrain-store --test sim",
        totals.violations(),
        totals.failures
    );
}

// ---- the tests -------------------------------------------------------------------------------

#[test]
fn embedded_one_owner_an_honest_run_matches_its_recorded_commits_and_is_sound() {
    for seed in seeds(40) {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let run = workload(&disk, seed, None).unwrap();
        assert_eq!(run.stopped, None, "seed {seed}");
        assert!(
            run.violations.is_empty(),
            "seed {seed}: {:?}",
            run.violations
        );
        let log = run.log.lock().unwrap();
        assert!(log.in_doubt.is_empty());
        assert!(
            log.committed.len() > 5,
            "seed {seed} committed only {}",
            log.committed.len()
        );
        let version = run.kv.version().unwrap();
        assert_eq!(version, log.last, "seed {seed}");
        check::check_serializable(&log.committed).expect("serializable");
        assert_eq!(
            check::replay_to(&log.committed, version),
            read_state(&*run.kv).unwrap(),
            "seed {seed}: the recorded commits do not rebuild the store"
        );
        assert_eq!(
            integrity(&*run.kv).unwrap(),
            Vec::<String>::new(),
            "seed {seed}"
        );
    }
}

#[test]
fn the_integrity_check_sees_damage() {
    // The first seed from 7 whose final state holds a record of every damaged kind.
    let wanted = [
        keys::PAGE_ID,
        keys::POSTING,
        keys::CHUNK,
        keys::REQUEST_ID,
        keys::LINK,
        keys::LINK_TO,
        keys::LINK_UNIQUE,
        keys::TIMELINE,
        keys::TIMELINE_DEDUP,
        keys::TIMELINE_LATEST,
    ];
    let (run, state) = (7..64)
        .find_map(|seed| {
            let disk = SimDisk::new(seed, FaultPlan::none());
            let run = workload(&disk, seed, None).unwrap();
            assert_eq!(
                integrity(&*run.kv).unwrap(),
                Vec::<String>::new(),
                "seed {seed}"
            );
            let state = read_state(&*run.kv).unwrap();
            wanted
                .iter()
                .all(|tag| state.keys().any(|k| k[0] == *tag))
                .then_some((run, state))
        })
        .expect("no seed from 7 to 63 leaves a record of every kind");
    let first = |tag: u8| {
        state
            .keys()
            .find(|k| k[0] == tag)
            .unwrap_or_else(|| panic!("the workload wrote no {:?} record", tag as char))
            .clone()
    };
    type Damage = (&'static str, Vec<u8>, Option<Vec<u8>>);
    let damages: Vec<Damage> = vec![
        ("an id index entry", first(keys::PAGE_ID), None),
        ("a posting", first(keys::POSTING), None),
        ("a chunk", first(keys::CHUNK), None),
        ("an idempotency index entry", first(keys::REQUEST_ID), None),
        ("a link", first(keys::LINK), None),
        ("a backlink index key", first(keys::LINK_TO), None),
        ("a link uniqueness key", first(keys::LINK_UNIQUE), None),
        ("a timeline entry", first(keys::TIMELINE), None),
        ("a timeline dedup key", first(keys::TIMELINE_DEDUP), None),
        (
            "a newest-entry time",
            first(keys::TIMELINE_LATEST),
            Some(0i64.to_be_bytes().to_vec()),
        ),
        (
            "the chunk totals",
            keys::meta("chunk_stats/chunks"),
            Some(0i64.to_le_bytes().to_vec()),
        ),
        (
            "the journal counters",
            keys::meta("journal_outstanding"),
            Some(99i64.to_le_bytes().to_vec()),
        ),
    ];
    for (what, key, replacement) in damages {
        let mut tx = run.kv.begin_write().unwrap();
        match &replacement {
            Some(value) => tx.put(&key, value).unwrap(),
            None => tx.delete(&key).unwrap(),
        }
        tx.commit().unwrap();
        let problems = integrity(&*run.kv).unwrap();
        assert!(!problems.is_empty(), "damage to {what} went unnoticed");
        // put the record back for the next case
        let mut tx = run.kv.begin_write().unwrap();
        tx.put(&key, &state[&key]).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            integrity(&*run.kv).unwrap(),
            Vec::<String>::new(),
            "restoring {what}"
        );
    }
}

#[test]
fn embedded_one_owner_a_crash_at_any_point_loses_nothing_and_tears_nothing() {
    let totals = run_kind(Kind::Crash, 200, "crash");
    assert_clean(&totals, "crash");
    assert_eq!(totals.refused, 0, "an honest disk must always reopen");
    assert!(totals.crashes > 0, "no seed crashed mid-run");
}

#[test]
fn embedded_one_owner_fsync_errors_and_lies_are_survived_or_refused_cleanly() {
    let totals = run_kind(Kind::FsyncFault, 200, "fsync-fault");
    assert_clean(&totals, "fsync-fault");
}

#[test]
fn the_control_run_must_report_violations() {
    let totals = run_kind(Kind::Control, 200, "control (expected to find violations)");
    if totals.seeds >= 50 {
        assert!(
            totals.violations() > 0,
            "every fsync lied and the crash kept a random subset, yet nothing was reported: the checker is blind"
        );
    }
}

#[test]
fn a_seed_replays_exactly() {
    for seed in seeds(20) {
        for kind in [Kind::Crash, Kind::FsyncFault] {
            let a = run_seed(seed, kind);
            let b = run_seed(seed, kind);
            assert_eq!(
                a.trace_hash, b.trace_hash,
                "seed {seed} {kind:?}: the trace differs between two runs"
            );
            assert_eq!(a.commits, b.commits, "seed {seed} {kind:?}");
            assert_eq!(a.io_ops, b.io_ops, "seed {seed} {kind:?}");
            assert_eq!(
                a.in_doubt_applied, b.in_doubt_applied,
                "seed {seed} {kind:?}"
            );
            assert_eq!(a.violations, b.violations, "seed {seed} {kind:?}");
        }
    }
}

#[test]
fn logged_a_crash_at_any_point_keeps_the_log_and_the_records_in_step() {
    let totals = run_kind_as(Kind::Crash, 200, "logged crash", LOGGED);
    assert_clean(&totals, "logged crash");
    assert_eq!(totals.refused, 0, "an honest disk must always reopen");
    assert!(totals.crashes > 0, "no seed crashed mid-run");
}

#[test]
fn logged_fsync_errors_and_lies_keep_the_log_and_the_records_in_step() {
    let totals = run_kind_as(Kind::FsyncFault, 200, "logged fsync-fault", LOGGED);
    assert_clean(&totals, "logged fsync-fault");
}

#[test]
fn logged_the_control_run_must_report_violations() {
    let totals = run_kind_as(
        Kind::Control,
        200,
        "logged control (expected to find violations)",
        LOGGED,
    );
    if totals.seeds >= 50 {
        assert!(totals.violations() > 0, "the logged checker is blind");
    }
}

#[test]
fn logged_an_honest_run_has_a_log_that_replays_to_its_records() {
    for seed in seeds(40) {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let run = workload_as(&disk, seed, None, LOGGED).unwrap();
        assert_eq!(run.stopped, None, "seed {seed}");
        assert!(
            run.violations.is_empty(),
            "seed {seed}: {:?}",
            run.violations
        );
        let baseline = run.baseline.clone().unwrap();
        check_log_replay(&*run.kv, &baseline, false).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        // The check is not blind: a key the log never wrote shows up.
        let mut extra = baseline.clone();
        extra.0.insert(b"zz/not-logged".to_vec(), b"x".to_vec());
        assert!(
            check_log_replay(&*run.kv, &extra, false).is_err(),
            "seed {seed}"
        );
    }
}

/// C19, P-H: the honest-run check on the optimistic store (multi-user mode and the commit log on, asserted in the run), the same
/// seeded clients and the same checks as `embedded_one_owner_an_honest_run_matches_its_recorded_commits_and_is_sound`, plus the
/// log replay of `logged_an_honest_run_has_a_log_that_replays_to_its_records`. The clients take their steps one at a time on the
/// seeded scheduler, so each commit is a batch of one; the interleaved batches of the optimistic pipeline are driven through the
/// `step_pipeline()` seam in `tests/multi_writer_sim.rs`.
#[test]
fn an_honest_run_matches_its_recorded_commits_and_is_sound_multi_writer() {
    for seed in seeds(40) {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let run = workload_as(&disk, seed, None, OPTIMISTIC).unwrap();
        assert_eq!(run.stopped, None, "seed {seed}");
        assert!(
            run.violations.is_empty(),
            "seed {seed}: {:?}",
            run.violations
        );
        let log = run.log.lock().unwrap();
        assert!(log.in_doubt.is_empty());
        assert!(
            log.committed.len() > 5,
            "seed {seed} committed only {}",
            log.committed.len()
        );
        let version = run.kv.version().unwrap();
        assert_eq!(version, log.last, "seed {seed}");
        check::check_serializable(&log.committed).expect("serializable");
        assert_eq!(
            check::replay_to(&log.committed, version),
            read_state(&*run.kv).unwrap(),
            "seed {seed}: the recorded commits do not rebuild the store"
        );
        assert_eq!(
            integrity(&*run.kv).unwrap(),
            Vec::<String>::new(),
            "seed {seed}"
        );
        let baseline = run.baseline.clone().unwrap();
        check_log_replay(&*run.kv, &baseline, true).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        // The check is not blind on the optimistic store either: a key the log never wrote shows up.
        let mut extra = baseline.clone();
        extra.0.insert(b"zz/not-logged".to_vec(), b"x".to_vec());
        assert!(
            check_log_replay(&*run.kv, &extra, true).is_err(),
            "seed {seed}"
        );
    }
}

/// C19, P-H: a crash at any point on the optimistic store (multi-user mode and the log on) loses no acknowledged commit and
/// tears none, the log and the records stay in step, and the store reopens and takes a write. Twin of
/// `embedded_one_owner_a_crash_at_any_point_loses_nothing_and_tears_nothing`.
#[test]
fn a_crash_at_any_point_loses_nothing_and_tears_nothing_multi_writer() {
    let totals = run_kind_as(Kind::Crash, 200, "optimistic crash", OPTIMISTIC);
    assert_clean(&totals, "optimistic crash");
    assert_eq!(totals.refused, 0, "an honest disk must always reopen");
    assert!(totals.crashes > 0, "no seed crashed mid-run");
    assert!(totals.commits > 0, "no commit was acknowledged");
}

/// C19, P-H: fsync errors and lies on the optimistic store are survived or refused cleanly. Twin of
/// `embedded_one_owner_fsync_errors_and_lies_are_survived_or_refused_cleanly`.
#[test]
fn fsync_errors_and_lies_are_survived_or_refused_cleanly_multi_writer() {
    let totals = run_kind_as(Kind::FsyncFault, 200, "optimistic fsync-fault", OPTIMISTIC);
    assert_clean(&totals, "optimistic fsync-fault");
    assert!(totals.commits > 0, "no commit was acknowledged");
}

/// The control of the two twins above: on the optimistic store, every fsync lies and the checker is told the disk was honest,
/// so it must report violations (a checker that cannot fail would pass the twins for nothing).
#[test]
fn the_control_run_must_report_violations_multi_writer() {
    let totals = run_kind_as(
        Kind::Control,
        200,
        "optimistic control (expected to find violations)",
        OPTIMISTIC,
    );
    if totals.seeds >= 50 {
        assert!(
            totals.violations() > 0,
            "the optimistic checker is blind: every fsync lied and nothing was reported"
        );
    }
}
