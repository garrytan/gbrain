//! Running a test over many seeds, with one-line repro.
//!
//! Environment:
//! - `GBRAIN_SIM_SEED=<n>`   run exactly that seed (the repro for a failure)
//! - `GBRAIN_SIM_SEEDS=<n>`  how many seeds to run (default: the test's fast count)
//! - `GBRAIN_SIM_BASE=<n>`   first seed of the range (default 0)

use std::panic::{AssertUnwindSafe, catch_unwind};

pub const ENV_SEED: &str = "GBRAIN_SIM_SEED";
pub const ENV_SEEDS: &str = "GBRAIN_SIM_SEEDS";
pub const ENV_BASE: &str = "GBRAIN_SIM_BASE";

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

/// The seeds a run should cover: one seed if `GBRAIN_SIM_SEED` is set, else `count` seeds from
/// `GBRAIN_SIM_BASE` (both overridable through the environment).
pub fn seeds(default_count: u64) -> Vec<u64> {
    if let Some(s) = env_u64(ENV_SEED) {
        return vec![s];
    }
    let base = env_u64(ENV_BASE).unwrap_or(0);
    let n = env_u64(ENV_SEEDS).unwrap_or(default_count);
    (base..base + n).collect()
}

/// The one-line repro for a failing seed.
pub fn repro_line(seed: u64, command: &str) -> String {
    format!("{ENV_SEED}={seed} {command}")
}

/// Run `f` for every seed. On the first failure (an `Err` or a panic) print the one-line repro to
/// stderr and panic with it, so a CI log names the seed that failed.
pub fn run_seeds<F>(command: &str, default_count: u64, f: F)
where
    F: Fn(u64) -> Result<(), String>,
{
    for seed in seeds(default_count) {
        let outcome = catch_unwind(AssertUnwindSafe(|| f(seed)));
        let failure = match outcome {
            Ok(Ok(())) => continue,
            Ok(Err(msg)) => msg,
            Err(p) => p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".to_string()),
        };
        let line = repro_line(seed, command);
        eprintln!("simulation failed: {failure}\nrepro: {line}");
        panic!("simulation failed at seed {seed}: {failure}\nrepro: {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repro_line_is_one_copyable_command() {
        assert_eq!(
            repro_line(42, "cargo test -p gbrain-sim x"),
            "GBRAIN_SIM_SEED=42 cargo test -p gbrain-sim x"
        );
    }

    #[test]
    #[should_panic(expected = "GBRAIN_SIM_SEED=")]
    fn a_failing_seed_names_its_repro() {
        run_seeds("cargo test -p gbrain-sim demo", 5, |s| {
            if s == 3 { Err("boom".into()) } else { Ok(()) }
        });
    }
}
