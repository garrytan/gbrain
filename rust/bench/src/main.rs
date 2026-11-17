//! gbrain-bakeoff: record-store bake-off harness. See README.md.

use gbrain_bakeoff::children::*;
use gbrain_bakeoff::corpus::Corpus;
use gbrain_bakeoff::engine::Engine;
use gbrain_bakeoff::simrun;
use gbrain_bakeoff::util::*;
use gbrain_bakeoff::vector;
use gbrain_bakeoff::workload::{write_result, Config, Run, ALL_METRICS};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage:
  gbrain-bakeoff run --engine redb|fjall|lmdb --corpus DIR --store DIR --scale 10k|200k --out FILE
                     [--only a,b,c] [--quick] [--no-commit-log]
  gbrain-bakeoff truth --corpus DIR
  gbrain-bakeoff list-metrics
  gbrain-bakeoff sim --engine redb|fjall|lmdb|all [--seeds N] [--kill-seeds N] [--base N]
                     [--kind crash,fault,layer,control] [--txns N] [--store DIR] [--out FILE] [--json]
                     (GBRAIN_SIM_SEED=<n> replays exactly one seed)
(child-* subcommands are started by `run` itself)";

struct Args {
    flags: HashMap<String, String>,
    switches: Vec<String>,
}

impl Args {
    fn parse(argv: &[String]) -> Result<Args, String> {
        let mut flags = HashMap::new();
        let mut switches = Vec::new();
        let mut it = argv.iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--quick" | "--no-commit-log" | "--json" => switches.push(a.clone()),
                f if f.starts_with("--") => {
                    let v = it.next().ok_or_else(|| format!("{f} needs a value"))?;
                    flags.insert(f.to_string(), v.clone());
                }
                other => return Err(format!("unexpected argument {other}")),
            }
        }
        Ok(Args { flags, switches })
    }
    fn get(&self, k: &str) -> Result<&str, String> {
        self.flags
            .get(k)
            .map(|s| s.as_str())
            .ok_or_else(|| format!("missing {k}"))
    }
    fn path(&self, k: &str) -> Result<PathBuf, String> {
        self.get(k).map(PathBuf::from)
    }
    fn has(&self, k: &str) -> bool {
        self.switches.iter().any(|s| s == k)
    }
    fn engine(&self) -> Result<Engine, String> {
        let e = self.get("--engine")?;
        Engine::parse(e).ok_or_else(|| format!("unknown engine {e} (redb, fjall, lmdb)"))
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first().cloned() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match dispatch(&cmd, &argv[1..]) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("error: {e}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn dispatch(cmd: &str, rest: &[String]) -> Result<u8, String> {
    let a = Args::parse(rest)?;
    match cmd {
        "run" => run(&a),
        "truth" => {
            let corpus = Corpus::open(&a.path("--corpus")?)?;
            let t = vector::ensure_truth(&corpus)?;
            eprintln!(
                "truth ready: {} queries at {}",
                t.top.len(),
                corpus.truth_path().display()
            );
            Ok(0)
        }
        "list-metrics" => {
            println!("{}", ALL_METRICS.join("\n"));
            Ok(0)
        }
        "child-cold-open" | "child-probe-open" => {
            let (engine, store) = (a.engine()?, a.path("--store")?);
            let f = if cmd == "child-cold-open" {
                child_cold_open
            } else {
                child_probe_open
            };
            Ok(f(
                engine,
                &store,
                !a.has("--no-commit-log"),
                a.get("--source")?,
                a.get("--slug")?,
            ) as u8)
        }
        "sim" => sim(&a),
        "child-sim-crash" => {
            let num = |k: &str| a.get(k)?.parse::<u64>().map_err(|e| format!("{k}: {e}"));
            Ok(simrun::child_sim_crash(
                a.engine()?,
                &a.path("--store")?,
                num("--seed")?,
                num("--txns")? as usize,
            ) as u8)
        }
        "child-crash" => {
            Ok(child_crash(a.engine()?, &a.path("--store")?, !a.has("--no-commit-log")) as u8)
        }
        "child-owner-client" => {
            let num = |k: &str| a.get(k)?.parse::<u64>().map_err(|e| format!("{k}: {e}"));
            Ok(child_owner_client(
                &a.path("--socket")?,
                &a.path("--keys")?,
                num("--gets")? as usize,
                num("--puts")? as usize,
                num("--seed")?,
            ) as u8)
        }
        other => Err(format!("unknown command {other}")),
    }
}

/// The simulations, per candidate. Prints a one-line summary per kind to stderr and, with
/// `--json` or `--out`, the metric rows (`sim_crash`, `sim_fsync_fault`, `sim_commit_layer`).
fn sim(a: &Args) -> Result<u8, String> {
    let num = |k: &str, default: u64| -> Result<u64, String> {
        match a.flags.get(k) {
            Some(v) => v.parse().map_err(|e| format!("{k}: {e}")),
            None => Ok(default),
        }
    };
    let engines: Vec<Engine> = match a.get("--engine")? {
        "all" => vec![Engine::Redb, Engine::Fjall, Engine::Lmdb],
        _ => vec![a.engine()?],
    };
    let seeds = num("--seeds", 500)?;
    let kill_seeds = num("--kill-seeds", seeds.min(40))?;
    let base = num("--base", 0)?;
    let txns = num("--txns", simrun::TXNS as u64)? as usize;
    let kinds: Vec<String> = a
        .flags
        .get("--kind")
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
        .unwrap_or_else(|| {
            vec![
                "crash".into(),
                "fault".into(),
                "layer".into(),
                "control".into(),
            ]
        });
    if let Some(bad) = kinds
        .iter()
        .find(|k| !["crash", "fault", "layer", "control"].contains(&k.as_str()))
    {
        return Err(format!(
            "unknown --kind {bad} (crash, fault, layer, control)"
        ));
    }
    let dir = a
        .flags
        .get("--store")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("gbrain-bakeoff-sim"));
    let mut doc = serde_json::Map::new();
    let mut violations = 0u64;
    for engine in engines {
        let mut rows = serde_json::Map::new();
        let name = engine.name();
        for kind in &kinds {
            let (key, totals, extra) = match (kind.as_str(), engine) {
                ("crash", Engine::Redb) => {
                    let s = simrun::pick_seeds(seeds, base);
                    (
                        "sim_crash",
                        simrun::run_redb_kind(simrun::Kind::Crash, &s, txns),
                        json!({"method": "in-process SimDisk under redb's StorageBackend: seeded crash point at any I/O call, drop / torn tail / reordered subset of unsynced writes", "fsync_fault_injection": true, "txns_per_seed": txns}),
                    )
                }
                ("fault", Engine::Redb) => {
                    let s = simrun::pick_seeds(seeds, base);
                    (
                        "sim_fsync_fault",
                        simrun::run_redb_kind(simrun::Kind::FsyncFault, &s, txns),
                        json!({"method": "in-process SimDisk under redb's StorageBackend: seeded fsync errors and fsync lies, then a crash", "fsync_fault_injection": true, "txns_per_seed": txns}),
                    )
                }
                ("control", Engine::Redb) => {
                    let s = simrun::pick_seeds(seeds, base);
                    (
                        "sim_negative_control",
                        simrun::run_redb_kind(simrun::Kind::Control, &s, txns),
                        json!({"method": "negative control: every fsync lies and the crash keeps a random subset of unsynced writes, but the checker is told the disk was honest. The store must then show up as refusing to open or as losing acknowledged commits; zero violations would mean the checkers are blind", "fsync_fault_injection": true, "txns_per_seed": txns}),
                    )
                }
                ("control", _) => continue,
                ("crash", _) => {
                    let s = simrun::pick_seeds(kill_seeds, base);
                    (
                        "sim_crash",
                        simrun::run_kill_kind(engine, &s, &dir.join(name), simrun::CHILD_TXNS),
                        json!({"method": "seeded SIGKILL of a child process writing the real store files, at a seed-chosen acknowledged commit plus a seeded sub-millisecond delay; reopen and check against a reference run of the same seed. A process kill keeps the OS page cache, so unsynced data survives: this tests recovery and atomicity, not fsync ordering or torn sectors", "fsync_fault_injection": false, "txns_per_seed": simrun::CHILD_TXNS}),
                    )
                }
                ("fault", _) => {
                    let t = simrun::Totals::default();
                    (
                        "sim_fsync_fault",
                        t,
                        json!({"supported": false, "fsync_fault_injection": false,
                        "note": format!("not measured: {name} writes real files, so fsync errors and fsync lies cannot be injected in-process, and no filesystem shim (LD_PRELOAD or FUSE) was built. This is a gap in the evidence for {name}, not a pass.")}),
                    )
                }
                _ => {
                    let s = simrun::pick_seeds(seeds, base);
                    let (t, extra) = simrun::run_layer(&s, txns);
                    ("sim_commit_layer", t, extra)
                }
            };
            if kind == "control" {
                // Expected to find violations; finding none means the checkers cannot fail.
                if totals.violations() == 0 && totals.seeds >= 20 {
                    violations += 1;
                    eprintln!("  NEGATIVE CONTROL FOUND NOTHING: the checkers may be blind");
                }
            } else {
                violations += totals.violations();
            }
            let mut row = totals.metric(engine, kind, extra);
            if key == "sim_fsync_fault" && engine != Engine::Redb {
                if let Some(m) = row.as_object_mut() {
                    for k in ["lost", "torn", "nonserializable", "corrupt", "ops_per_s"] {
                        m.insert(k.into(), serde_json::Value::Null);
                    }
                }
            }
            eprintln!(
                "[{name}] {key}: seeds {} crash_points {} faults {} lost {} torn {} nonserializable {} corrupt {} ({:.1}s)",
                totals.seeds,
                totals.crash_points,
                totals.faults,
                row["lost"],
                row["torn"],
                row["nonserializable"],
                row["corrupt"],
                totals.elapsed.as_secs_f64()
            );
            for (seed, why) in totals.failed_seeds.iter().filter(|_| kind != "control") {
                eprintln!("  FAILED seed {seed}: {why}\n  repro: GBRAIN_SIM_SEED={seed} cargo run --release -- sim --engine {name} --kind {kind}");
            }
            for e in &totals.harness_errors {
                eprintln!("  HARNESS ERROR {e}");
            }
            rows.insert(key.into(), row);
        }
        doc.insert(name.into(), serde_json::Value::Object(rows));
    }
    let doc = serde_json::Value::Object(doc);
    if let Some(out) = a.flags.get("--out") {
        write_result(std::path::Path::new(out), &doc)
            .map_err(|e| format!("cannot write {out}: {e}"))?;
    }
    if a.has("--json") {
        println!("{doc}");
    }
    Ok(if violations == 0 { 0 } else { 1 })
}

fn variant(commit_log: bool) -> String {
    if commit_log {
        "occ-group-commit".into()
    } else {
        "occ-group-commit-nolog".into()
    }
}

fn run(a: &Args) -> Result<u8, String> {
    let cfg = Config {
        engine: a.engine()?,
        corpus: a.path("--corpus")?,
        store: a.path("--store")?,
        scale: a.get("--scale")?.to_string(),
        out: a.path("--out")?,
        only: a.flags.get("--only").map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect()
        }),
        quick: a.has("--quick"),
        commit_log: !a.has("--no-commit-log"),
    };
    if let Some(only) = &cfg.only {
        if let Some(bad) = only.iter().find(|o| !ALL_METRICS.contains(&o.as_str())) {
            return Err(format!("unknown metric {bad}; `list-metrics` shows them"));
        }
    }
    let started_at = now_iso();
    let mut run = Run::new(cfg.clone())?;
    run.notes.extend(standing_notes(&cfg));
    run.run_all();
    let doc = json!({
        "format": "gbrain-bakeoff-result/1",
        "engine": cfg.engine.name(),
        "variant": variant(cfg.commit_log),
        "scale": cfg.scale,
        "chunks": run.chunks(),
        "pages": run.page_count(),
        "machine": machine_info(),
        "git_sha": git_sha(),
        "started_at": started_at,
        "quick": cfg.quick,
        "metrics": run.metrics,
        "notes": run.notes,
    });
    write_result(&cfg.out, &doc).map_err(|e| format!("cannot write {}: {e}", cfg.out.display()))?;
    eprintln!("result written to {}", cfg.out.display());
    if run.failed_checks.is_empty() {
        Ok(0)
    } else {
        for f in &run.failed_checks {
            eprintln!("FAILED CHECK: {f}");
        }
        Ok(1)
    }
}

fn standing_notes(cfg: &Config) -> Vec<String> {
    let mut n = vec![
        format!(
            "Rust bake-off harness: the same gbrain-owned optimistic transaction layer (single ordered commit pipeline, group commit, read-set validation) runs over each base store; this run used {}. Numbers are raw store numbers: no napi crossing and no TypeScript wrapper.",
            cfg.engine.name()
        ),
        "Durability: every acknowledged commit is fsynced (redb Durability::Immediate, LMDB default flags, fjall PersistMode::SyncAll).".into(),
        format!("Vector scan kernel: {}. It is an exact brute-force scan over an in-memory f32 matrix loaded from the store, not an ANN index; the ANN follow-up (usearch or an own HNSW) is decided after parity.", vector::simd_path()),
        "vector_ann is not measured here: no ANN index exists in this harness yet.".into(),
        "A Fjall OptimisticTxDatabase variant (store-native optimistic transactions) was not built; fjall runs under the same gbrain layer as the other stores.".into(),
        "cold_open measures a fresh process with a warm OS file cache.".into(),
    ];
    if cfg.commit_log {
        n.push("The commit log is on: every write is stored twice (record + log entry), which roughly doubles bytes written. Use --no-commit-log to see the cost.".into());
    } else {
        n.push("Variant occ-group-commit-nolog: the commit log is OFF, so a future follower could not replay; crash_recovery skips the log-contiguity check.".into());
    }
    if cfg.quick {
        n.push("--quick: operation counts divided by 10 and fixed-duration runs shortened to 1 s; not comparable with a full run.".into());
    }
    n
}
