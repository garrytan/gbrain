//! Damages the keyword index or the core term postings of a stopped Rust brain, for the
//! `gbrain doctor` derived-index drills
//! (test/rust-doctor-derived-index.serial.test.ts; docs/designs/RUST_ENGINE.md, "Failure drills").
//!
//! A development tool only: it is never linked into the addon, and nothing in the shipped engine
//! can reach it. It opens `records.redb` directly, so the brain must have no running owner (redb
//! refuses a second open of the file).
//!
//! ```text
//! cargo run -p gbrain-store --example derived_fault -- <brain dir> drop-chunk-postings
//!     deletes every chunk posting (`R 0x01`) and leaves the state complete: keyword search
//!     through the postings then misses what the records hold
//! cargo run -p gbrain-store --example derived_fault -- <brain dir> garbage-state
//!     overwrites the index state record (`R 0x00`) with bytes that do not parse
//! cargo run -p gbrain-store --example derived_fault -- <brain dir> damage-term-postings
//!     deletes the first two core term postings (`T`), changes the frequency of the third and
//!     adds one posting no chunk holds: 2 missing, 1 changed, 1 orphan
//! cargo run -p gbrain-store --example derived_fault -- <brain dir> builder-fail
//!     adds a page id key whose page record does not parse and marks the index incomplete, so
//!     the next open's background build fails on that page and stops
//! cargo run -p gbrain-store --example derived_fault -- <brain dir> heal-page-id
//!     deletes the page id key `builder-fail` added (the index stays incomplete)
//! cargo run -p gbrain-store --example derived_fault -- <brain dir> show
//!     prints the state record, the count of each `R` record kind and the count of `T` records
//! cargo run -p gbrain-store --example derived_fault -- <brain dir> digest
//!     prints a SHA-256 of every key and value under each first key byte (the tag), so a drill can
//!     show a repair changed no record outside the `R` and `T` tags
//! ```
//!
//! Each mode prints one JSON line: what it changed.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::ExitCode;

use sha2::{Digest, Sha256};

use gbrain_store::keys;
use gbrain_store::kv::Kv;
use gbrain_store::redb_kv::RedbKv;

/// The state record `garbage-state` writes: not JSON.
const GARBAGE: &[u8] = b"{not json";

/// The page id `builder-fail` adds an id key for, past any page a drill brain holds.
const DANGLING_PAGE: u64 = 999_999_999;

/// The incomplete state `builder-fail` writes (index layout 1, cursor at the first page).
const INCOMPLETE: &[u8] = br#"{"version":1,"complete":false,"cursor":0}"#;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (Some(dir), Some(mode)) = (args.get(1), args.get(2)) else {
        eprintln!(
            "usage: derived_fault <brain dir> drop-chunk-postings|garbage-state|damage-term-postings|builder-fail|heal-page-id|show|digest"
        );
        return ExitCode::from(2);
    };
    match run(Path::new(dir), mode) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("derived_fault: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(dir: &Path, mode: &str) -> Result<String, String> {
    let kv = RedbKv::open_existing_path(&dir.join("records.redb"))
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let err = |e: gbrain_store::error::StoreError| format!("{}: {}", e.code, e.message);
    let state_key = keys::keyword_index_state();
    match mode {
        "drop-chunk-postings" => {
            let prefix = [keys::TRIGRAM, keys::KW_CHUNK_POSTING];
            let end = [keys::TRIGRAM, keys::KW_CHUNK_POSTING + 1];
            let mut doomed = Vec::new();
            kv.snapshot()
                .map_err(err)?
                .scan(&prefix, &end, false, &mut |k, _| {
                    doomed.push(k.to_vec());
                    true
                })
                .map_err(err)?;
            let mut tx = kv.begin_write().map_err(err)?;
            for key in &doomed {
                tx.delete(key).map_err(err)?;
            }
            tx.commit().map_err(err)?;
            Ok(
                serde_json::json!({ "mode": "drop-chunk-postings", "deleted": doomed.len() })
                    .to_string(),
            )
        }
        "garbage-state" => {
            let mut tx = kv.begin_write().map_err(err)?;
            tx.put(&state_key, GARBAGE).map_err(err)?;
            tx.commit().map_err(err)?;
            Ok("{\"mode\":\"garbage-state\"}".to_owned())
        }
        "damage-term-postings" => {
            let mut first = Vec::new();
            kv.snapshot()
                .map_err(err)?
                .scan(
                    &[keys::POSTING],
                    &[keys::POSTING + 1],
                    false,
                    &mut |k, _| {
                        first.push(k.to_vec());
                        first.len() < 3
                    },
                )
                .map_err(err)?;
            if first.len() < 3 {
                return Err(format!(
                    "the brain holds {} term postings; 3 needed",
                    first.len()
                ));
            }
            let orphan = keys::posting("orphanterm", 1, 9_999);
            let mut tx = kv.begin_write().map_err(err)?;
            tx.delete(&first[0]).map_err(err)?;
            tx.delete(&first[1]).map_err(err)?;
            tx.put(&first[2], &999u32.to_be_bytes()).map_err(err)?;
            tx.put(&orphan, &1u32.to_be_bytes()).map_err(err)?;
            tx.commit().map_err(err)?;
            Ok(serde_json::json!({
                "mode": "damage-term-postings", "deleted": 2, "changed": 1, "added": 1,
            })
            .to_string())
        }
        "builder-fail" | "heal-page-id" => {
            // The id key names itself as the page record, so reading the page reads the key's own
            // bytes, which are not JSON. Only a walk of the page ids (the build, the repair) reaches it.
            let bad = keys::page_id(DANGLING_PAGE);
            let mut tx = kv.begin_write().map_err(err)?;
            if mode == "builder-fail" {
                tx.put(&bad, &bad).map_err(err)?;
                tx.put(&state_key, INCOMPLETE).map_err(err)?;
            } else {
                tx.delete(&bad).map_err(err)?;
            }
            tx.commit().map_err(err)?;
            Ok(serde_json::json!({ "mode": mode, "page_id": DANGLING_PAGE }).to_string())
        }
        "show" => {
            let snapshot = kv.snapshot().map_err(err)?;
            let state = snapshot
                .get(&state_key)
                .map_err(err)?
                .map(|v| String::from_utf8_lossy(&v).into_owned());
            let mut kinds: BTreeMap<u8, u64> = BTreeMap::new();
            snapshot
                .scan(
                    &[keys::TRIGRAM],
                    &[keys::TRIGRAM + 1],
                    false,
                    &mut |k, _| {
                        *kinds.entry(k.get(1).copied().unwrap_or(0)).or_default() += 1;
                        true
                    },
                )
                .map_err(err)?;
            let kinds: BTreeMap<String, u64> =
                kinds.into_iter().map(|(k, n)| (k.to_string(), n)).collect();
            let mut terms = 0u64;
            snapshot
                .scan(
                    &[keys::POSTING],
                    &[keys::POSTING + 1],
                    false,
                    &mut |_, _| {
                        terms += 1;
                        true
                    },
                )
                .map_err(err)?;
            Ok(
                serde_json::json!({ "mode": "show", "state": state, "kinds": kinds, "terms": terms })
                    .to_string(),
            )
        }
        "digest" => {
            let mut tags: BTreeMap<u8, (u64, Sha256)> = BTreeMap::new();
            kv.snapshot()
                .map_err(err)?
                .scan(&[], &[0xff; 64], false, &mut |k, v| {
                    let (n, hash) = tags
                        .entry(k.first().copied().unwrap_or(0))
                        .or_insert_with(|| (0, Sha256::new()));
                    *n += 1;
                    for part in [k, v] {
                        hash.update((part.len() as u64).to_be_bytes());
                        hash.update(part);
                    }
                    true
                })
                .map_err(err)?;
            let tags: BTreeMap<String, serde_json::Value> = tags
                .into_iter()
                .map(|(tag, (n, hash))| {
                    let hex: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
                    (
                        format!("{tag:02x}"),
                        serde_json::json!({ "records": n, "sha256": hex }),
                    )
                })
                .collect();
            Ok(serde_json::json!({ "mode": "digest", "tags": tags }).to_string())
        }
        other => Err(format!("unknown mode {other}")),
    }
}
