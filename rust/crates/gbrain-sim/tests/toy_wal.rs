//! End-to-end check of the harness on a toy store: a write-ahead log on `SimDisk`, driven by the
//! scheduler, with crashes and fsync faults, judged by the checkers. It proves the pieces work
//! together in this workspace without any real store, and that the checkers can fail: the same
//! toy with the fsync before the acknowledgement removed must be caught losing commits.

use gbrain_sim::check::{self, Class, Committed, Model, Reopen, Violation};
use gbrain_sim::seed::run_seeds;
use gbrain_sim::trace::fnv1a;
use gbrain_sim::{CrashMode, Cx, FaultPlan, Scheduler, SimDisk, SimFile, SimRng, Step, Task};

/// Record: version u64, key count u8, then (key u8, present u8, value u8) per write; framed as
/// length u32, checksum u64, payload.
fn encode(version: u64, writes: &[(u8, Option<u8>)]) -> Vec<u8> {
    let mut p = version.to_le_bytes().to_vec();
    p.push(writes.len() as u8);
    for (k, v) in writes {
        p.extend([*k, v.is_some() as u8, v.unwrap_or(0)]);
    }
    let mut out = (p.len() as u32).to_le_bytes().to_vec();
    out.extend(fnv1a(&p).to_le_bytes());
    out.extend(p);
    out
}

/// Replay valid, contiguous records; stop at the first bad one.
fn recover(log: &[u8]) -> (u64, Model) {
    let (mut pos, mut version, mut state) = (0usize, 0u64, Model::new());
    while pos + 12 <= log.len() {
        let len = u32::from_le_bytes(log[pos..pos + 4].try_into().unwrap()) as usize;
        let sum = u64::from_le_bytes(log[pos + 4..pos + 12].try_into().unwrap());
        let Some(p) = log.get(pos + 12..pos + 12 + len) else {
            break;
        };
        if len < 9 || fnv1a(p) != sum {
            break;
        }
        let v = u64::from_le_bytes(p[0..8].try_into().unwrap());
        if v != version + 1 {
            break;
        }
        for w in p[9..].chunks(3) {
            if w[1] == 1 {
                state.insert(vec![w[0]], vec![w[2]]);
            } else {
                state.remove(&vec![w[0]]);
            }
        }
        version = v;
        pos += 12 + len;
    }
    (version, state)
}

struct World {
    log: SimFile,
    end: u64,
    version: u64,
    sync_before_ack: bool,
    committed: Vec<Committed>,
    in_doubt: Vec<Committed>,
    failed: bool,
    left: usize,
}

struct Client;

impl Task<World> for Client {
    fn name(&self) -> &str {
        "client"
    }
    fn ready(&self, w: &World) -> bool {
        !w.failed && w.left > 0
    }
    fn step(&mut self, w: &mut World, cx: &mut Cx<'_>) -> Step {
        w.left -= 1;
        let writes: Vec<(u8, Option<u8>)> = (0..1 + cx.rng.below(3))
            .map(|_| {
                let k = cx.rng.below(4) as u8;
                (
                    k,
                    if cx.rng.below(5) == 0 {
                        None
                    } else {
                        Some(cx.rng.below(200) as u8)
                    },
                )
            })
            .collect();
        let version = w.version + 1;
        let rec = Committed {
            snapshot: w.version,
            version,
            reads: vec![],
            writes: writes
                .iter()
                .map(|(k, v)| (vec![*k], v.map(|v| vec![v])))
                .collect(),
        };
        let bytes = encode(version, &writes);
        let ok =
            w.log.write_at(w.end, &bytes).is_ok() && (!w.sync_before_ack || w.log.sync().is_ok());
        cx.trace.event(&format!("commit {version} ok {ok}"));
        if ok {
            w.end += bytes.len() as u64;
            w.version = version;
            w.committed.push(rec);
        } else {
            w.failed = true;
            w.in_doubt.push(rec);
        }
        Step::Continue
    }
}

/// One seeded run: workload, crash, reboot, recover, judge. Returns violations and the trace hash.
fn run(seed: u64, sync_before_ack: bool, with_faults: bool) -> (Vec<Violation>, u64) {
    let mut rng = SimRng::new(seed ^ 0xABCD);
    let modes = [
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    let plan = FaultPlan {
        fsync_error_pm: if with_faults && rng.chance(300) {
            80
        } else {
            0
        },
        fsync_lie_pm: if with_faults && rng.chance(300) {
            300
        } else {
            0
        },
        crash_at_op: Some(1 + rng.below(40) as u64),
        crash_mode: modes[rng.below(3)],
    };
    let lie_possible = plan.fsync_lie_pm > 0;
    let disk = SimDisk::new(seed, plan);
    let mut world = World {
        log: disk.open("wal"),
        end: 0,
        version: 0,
        sync_before_ack,
        committed: vec![],
        in_doubt: vec![],
        failed: false,
        left: 30,
    };
    let mut sched = Scheduler::new(seed);
    sched.spawn(Box::new(Client));
    sched.spawn(Box::new(Client));
    sched.run(&mut world, 10_000, |_| false);
    disk.crash_now();
    let lied = lie_possible && disk.stats().fsync_lies > 0;
    disk.reboot();
    let len = disk.open("wal").len().unwrap() as usize;
    let mut log = vec![0u8; len];
    disk.open("wal").read_at(0, &mut log).unwrap();
    let (version, state) = recover(&log);
    let verdict = check::check_recovery(
        &world.committed,
        &world.in_doubt,
        lied,
        &Reopen::Opened { version, state },
    );
    (verdict.violations, sched.trace.hash())
}

#[test]
fn a_correct_wal_survives_seeded_crashes_and_fsync_faults() {
    for with_faults in [false, true] {
        run_seeds(
            "cargo test -p gbrain-sim --test toy_wal a_correct_wal_survives_seeded_crashes_and_fsync_faults",
            300,
            |seed| match run(seed, true, with_faults).0.first() {
                Some(v) => Err(format!("{}: {}", v.class.name(), v.message)),
                None => Ok(()),
            },
        );
    }
}

#[test]
fn the_same_seed_gives_the_same_trace_hash_through_the_whole_stack() {
    for seed in [1, 2, 3, 500] {
        assert_eq!(run(seed, true, true), run(seed, true, true), "seed {seed}");
    }
}

/// The harness must be able to catch a real bug: acknowledging before the fsync loses commits.
#[test]
fn a_wal_that_acks_before_fsync_is_caught_losing_commits() {
    let lost = (0..300u64)
        .filter(|s| {
            run(*s, false, false)
                .0
                .iter()
                .any(|v| v.class == Class::Lost)
        })
        .count();
    assert!(
        lost > 20,
        "only {lost} of 300 seeds caught the missing fsync"
    );
}
