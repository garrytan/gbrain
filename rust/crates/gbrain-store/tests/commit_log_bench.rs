//! What the commit log costs a write (multi-user mode): the same workload with the log off and on,
//! on both store modes, with small and 64 KiB values, one writer and eight. A measurement, not a
//! gate (no speed bar blocks a merge): run with
//! `cargo test -p gbrain-store --release --test commit_log_bench -- --ignored --nocapture`.

mod common;

use common::TempDir;
use gbrain_store::{MultiUserWrites, OpenOptions, Store};
use std::sync::Arc;
use std::time::Instant;

fn open(dir: &TempDir, concurrent: bool, logged: bool) -> Store {
    let writes = MultiUserWrites {
        commit_log: logged,
        write_origin: logged,
        host_id: logged.then(|| "d0000000-0000-4000-8000-0000000000d1".to_string()),
        log_retention_bytes: None,
    };
    Store::open_dir(
        &dir.path().join("brain"),
        OpenOptions {
            concurrent_writes: concurrent,
            keyword_index_builder: false,
            multiuser: logged,
            multiuser_writes: writes,
            ..OpenOptions::default()
        },
    )
    .unwrap()
}

fn dir_bytes(dir: &TempDir) -> u64 {
    std::fs::read_dir(dir.path().join("brain"))
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum()
}

#[test]
#[ignore = "measurement"]
fn commit_log_write_cost() {
    println!("| store | writers | value | log | writes | mean us/write | total ms | brain bytes |");
    println!("|---|---|---|---|---|---|---|---|");
    for concurrent in [false, true] {
        for writers in [1usize, 8] {
            if writers > 1 && !concurrent {
                continue;
            }
            for size in [40usize, 64 << 10] {
                for logged in [false, true] {
                    let dir = TempDir::new("bench");
                    let store = Arc::new(open(&dir, concurrent, logged));
                    let per = if size > 1000 { 200 } else { 1000 } / writers;
                    let value: String = "v".repeat(size);
                    let start = Instant::now();
                    let threads: Vec<_> = (0..writers)
                        .map(|t| {
                            let store = store.clone();
                            let value = value.clone();
                            std::thread::spawn(move || {
                                for i in 0..per {
                                    store
                                        .set_config(&format!("bench.t{t}.k{}", i % 16), &value)
                                        .unwrap();
                                }
                            })
                        })
                        .collect();
                    for t in threads {
                        t.join().unwrap();
                    }
                    let elapsed = start.elapsed();
                    let n = per * writers;
                    drop(store);
                    println!(
                        "| {} | {writers} | {size} | {} | {n} | {:.0} | {} | {} |",
                        if concurrent {
                            "optimistic"
                        } else {
                            "single-writer"
                        },
                        if logged { "on" } else { "off" },
                        elapsed.as_micros() as f64 / n as f64,
                        elapsed.as_millis(),
                        dir_bytes(&dir)
                    );
                }
            }
        }
    }
}
