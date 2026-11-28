//! Ids of a commit the pipeline refused for a conflict go back (`occ_kv.rs`, "Id sequences"): many
//! runs of two writers that conflict on one key, with and without a third writer that takes ids
//! from the same sequence. No id is ever held by two committed records; with no third writer and
//! the loser taking its id last, the ids stay dense and the refusal writes no forward record.

use super::*;
use crate::error::WRITE_CONFLICT;
use crate::test_support::mu_store;
use std::sync::{Barrier, Mutex as StdMutex};

const RUNS: u64 = 10_000;
const SEQUENCE: &str = "next_give_back_probe_id";

fn optimistic() -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        ..TxnOptions::default()
    }
}

fn record_key(id: u64) -> Vec<u8> {
    let mut key = b"yrec/".to_vec();
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn take_id(w: &mut dyn KvWrite) -> Result<u64> {
    crate::pages::next_id(w, SEQUENCE)
}

/// One attempt of a writer: read the hot key, take an id, write a record under it and the hot key.
fn attempt(s: &Store, name: &[u8]) -> Result<u64> {
    let t = s.begin_bound(optimistic())?;
    let run = (|| {
        t.read()?.get(b"yhot")?;
        let id = t.write(take_id)?;
        t.write(|w| {
            w.put(&record_key(id), name)?;
            w.put(b"yhot", name)
        })?;
        t.commit_transaction()?;
        Ok(id)
    })();
    if run.is_err() {
        let _ = t.rollback_transaction();
    }
    run
}

/// Runs `attempt` until it commits; returns the committed id.
fn until_committed(s: &Store, name: &[u8]) -> u64 {
    loop {
        match attempt(s, name) {
            Ok(id) => return id,
            Err(e) if e.code == WRITE_CONFLICT => continue,
            Err(e) => panic!("a writer failed: {e}"),
        }
    }
}

/// Every committed record holds the writer that committed it: no id went to two committed records.
fn assert_each_record_is_its_writers(s: &Store, committed: &[(u64, Vec<u8>)]) {
    let mut seen = BTreeSet::new();
    for (id, name) in committed {
        assert!(seen.insert(*id), "id {id} was committed by two writers");
        let stored = s.read().unwrap().get(&record_key(*id)).unwrap();
        assert_eq!(
            stored.as_deref(),
            Some(name.as_slice()),
            "record {id} was overwritten by another writer"
        );
    }
}

/// Two writers that conflict on one key, the loser taking its id after the winner: the refused
/// commit gives its id back, the run again takes it, the ids stay dense and the refusal adds no
/// commit of its own (no forward record).
#[test]
fn a_conflict_loser_that_took_the_last_id_runs_again_on_the_same_id_with_no_gap() {
    let s = mu_store();
    let mut committed = Vec::new();
    for run in 0..RUNS {
        let winner = s.begin_bound(optimistic()).unwrap();
        let loser = s.begin_bound(optimistic()).unwrap();
        winner.read().unwrap().get(b"yhot").unwrap();
        loser.read().unwrap().get(b"yhot").unwrap();
        let won = winner.write(take_id).unwrap();
        let lost = loser.write(take_id).unwrap();
        assert_eq!(lost, won + 1);
        for (t, id, name) in [(&winner, won, b"w"), (&loser, lost, b"l")] {
            t.write(|w| {
                w.put(&record_key(id), name)?;
                w.put(b"yhot", name)
            })
            .unwrap();
        }
        winner.commit_transaction().unwrap();
        let before = s.kv.version().unwrap();
        assert_eq!(loser.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
        assert_eq!(
            s.kv.version().unwrap(),
            before,
            "run {run}: the refused commit wrote a record of its own"
        );
        let again = until_committed(&s, b"l");
        assert_eq!(again, lost, "run {run}: the run again took a new id");
        committed.push((won, b"w".to_vec()));
        committed.push((again, b"l".to_vec()));
    }
    let ids: Vec<u64> = committed.iter().map(|(id, _)| *id).collect();
    let dense: Vec<u64> = (1..=2 * RUNS).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, dense, "the committed ids have a gap");
    assert_each_record_is_its_writers(&s, &committed);
    // The committed sequence record is exactly past the last id: never lowered, never raised past.
    let stored = s
        .read()
        .unwrap()
        .get(&keys::meta(SEQUENCE))
        .unwrap()
        .and_then(|v| keys::be8(&v));
    assert_eq!(stored, Some(2 * RUNS + 1));
}

/// A third writer takes an id between the loser's and its refusal: nothing goes back (the old rule),
/// so no id is handed out twice.
#[test]
fn a_later_id_from_another_writer_keeps_the_refused_ids_used() {
    let s = mu_store();
    let mut committed = Vec::new();
    for _ in 0..RUNS {
        let winner = s.begin_bound(optimistic()).unwrap();
        let loser = s.begin_bound(optimistic()).unwrap();
        winner.read().unwrap().get(b"yhot").unwrap();
        loser.read().unwrap().get(b"yhot").unwrap();
        let lost = loser.write(take_id).unwrap();
        let third = s
            .write(|w| {
                let id = take_id(w)?;
                w.put(&record_key(id), b"3")?;
                Ok(id)
            })
            .unwrap();
        assert!(third > lost);
        winner.write(|w| w.put(b"yhot", b"w")).unwrap();
        loser
            .write(|w| {
                w.put(&record_key(lost), b"l")?;
                w.put(b"yhot", b"l")
            })
            .unwrap();
        winner.commit_transaction().unwrap();
        assert_eq!(loser.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
        let again = until_committed(&s, b"l");
        assert!(again > third, "id {again} was handed out again");
        committed.push((third, b"3".to_vec()));
        committed.push((again, b"l".to_vec()));
    }
    assert_each_record_is_its_writers(&s, &committed);
}

/// Many runs of two writers racing on one key and a third writer taking ids from the same sequence,
/// each on its own thread: no id is held by two committed records, whatever the interleaving.
#[test]
fn racing_writers_and_a_third_id_taker_never_share_an_id() {
    let s = Arc::new(mu_store());
    let runs = RUNS;
    let barrier = Arc::new(Barrier::new(3));
    let committed = Arc::new(StdMutex::new(Vec::new()));
    let writers: Vec<_> = [b"a".as_slice(), b"b", b"3"]
        .into_iter()
        .map(|name| {
            let (s, barrier, committed) = (s.clone(), barrier.clone(), committed.clone());
            std::thread::spawn(move || {
                for run in 0..runs {
                    barrier.wait();
                    let id = if name == b"3" {
                        if run % 2 == 1 {
                            continue;
                        }
                        s.write(|w| {
                            let id = take_id(w)?;
                            w.put(&record_key(id), name)?;
                            Ok(id)
                        })
                        .unwrap()
                    } else {
                        until_committed(&s, name)
                    };
                    committed.lock().unwrap().push((id, name.to_vec()));
                }
            })
        })
        .collect();
    for w in writers {
        w.join().unwrap();
    }
    let committed = committed.lock().unwrap();
    assert_eq!(committed.len() as u64, 2 * runs + runs / 2);
    assert_each_record_is_its_writers(&s, &committed);
}

/// The plain write path (`Store::write`): a write whose commit lost a conflict runs again on the
/// same id when no other id was taken.
#[test]
fn a_plain_write_that_lost_a_conflict_runs_again_on_the_same_id() {
    let s = Arc::new(mu_store());
    for _ in 0..1_000 {
        let mut ids = Vec::new();
        s.write(|w| {
            w.get(b"yhot")?;
            let id = take_id(w)?;
            ids.push(id);
            if ids.len() == 1 {
                let other = s.clone();
                std::thread::spawn(move || other.write(|w| w.put(b"yhot", b"other")))
                    .join()
                    .unwrap()?;
            }
            w.put(&record_key(id), b"p")?;
            w.put(b"yhot", b"p")
        })
        .unwrap();
        assert_eq!(ids.len(), 2, "the write did not run again");
        assert_eq!(ids[0], ids[1], "the run again took a new id");
    }
}
