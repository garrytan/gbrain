//! The SIGKILL simulation for fjall and LMDB, driven through the real binary.

use gbrain_bakeoff::engine::Engine;
use gbrain_bakeoff::simrun::{kill_seed, kill_seed_against, CHILD_TXNS};

fn scratch(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("gbrain-sim-kill-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn point_at_binary() {
    // SAFETY: set before any thread of this test starts a child.
    unsafe { std::env::set_var("GBRAIN_BAKEOFF_EXE", env!("CARGO_BIN_EXE_gbrain-bakeoff")) };
}

#[test]
fn killed_children_recover_to_a_committed_prefix() {
    point_at_binary();
    for engine in [Engine::Fjall, Engine::Lmdb] {
        let dir = scratch(engine.name());
        for seed in 0..4 {
            let r = kill_seed(engine, seed, &dir, CHILD_TXNS).expect("harness");
            assert!(
                r.violations.is_empty(),
                "{} seed {seed}: {:?}\nrepro: GBRAIN_SIM_SEED={seed} cargo run --release -- sim --engine {} --kind crash",
                engine.name(),
                r.violations,
                engine.name()
            );
            assert!(r.crash_hit, "the child should have been killed mid-run");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The checker must be able to fail: against the wrong reference history the same recovered
/// store must be reported as a violation.
#[test]
fn checking_against_the_wrong_history_is_flagged() {
    point_at_binary();
    let dir = scratch("control");
    let flagged = (0..6).any(|seed| {
        let r =
            kill_seed_against(Engine::Lmdb, seed, seed + 1000, &dir, CHILD_TXNS).expect("harness");
        !r.violations.is_empty()
    });
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        flagged,
        "a wrong reference history was never flagged: the kill checker is blind"
    );
}
