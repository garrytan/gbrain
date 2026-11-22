//! Checkers over a recorded history. A history is the list of committed transactions, each with
//! the reads it observed and the writes it made, plus (after a crash) what the store looks like
//! once reopened. Every checker returns a [`Violation`] instead of panicking so a driver can
//! count them by class; [`Violation::class`] is what a results table reports.
//!
//! - lost: a commit the store acknowledged is gone after recovery.
//! - torn: a read or a recovered state that matches no committed prefix (half a commit).
//! - nonserializable: the committed history cannot be replayed one commit at a time.
//! - corrupt: reopening panicked, refused after a crash it must survive, or produced a state that
//!   is not a prefix of the history at all.

use std::collections::BTreeMap;

pub type Key = Vec<u8>;
pub type Value = Vec<u8>;
/// `None` is a delete.
pub type WriteSet = Vec<(Key, Option<Value>)>;
pub type Model = BTreeMap<Key, Value>;
pub type Own = BTreeMap<Key, Option<Value>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Class {
    Lost,
    Torn,
    Nonserializable,
    Corrupt,
}

impl Class {
    pub fn name(self) -> &'static str {
        match self {
            Class::Lost => "lost",
            Class::Torn => "torn",
            Class::Nonserializable => "nonserializable",
            Class::Corrupt => "corrupt",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Violation {
    pub class: Class,
    pub message: String,
}

fn violation(class: Class, message: String) -> Violation {
    Violation { class, message }
}

#[derive(Clone, Debug)]
pub enum ReadObs {
    Point {
        key: Key,
        value: Option<Value>,
    },
    Range {
        start: Key,
        end: Key,
        limit: usize,
        /// The transaction's own writes when it made the range read (they show through the scan).
        own: Own,
        rows: Vec<(Key, Value)>,
    },
}

#[derive(Clone, Debug)]
pub struct Committed {
    /// The snapshot version the transaction read at.
    pub snapshot: u64,
    /// The version it committed as.
    pub version: u64,
    pub reads: Vec<ReadObs>,
    pub writes: WriteSet,
}

/// The smallest key greater than `k`.
pub fn key_successor(k: &[u8]) -> Key {
    let mut s = k.to_vec();
    s.push(0);
    s
}

pub fn apply_writes(model: &mut Model, writes: &WriteSet) {
    for (k, v) in writes {
        match v {
            Some(v) => {
                model.insert(k.clone(), v.clone());
            }
            None => {
                model.remove(k);
            }
        }
    }
}

/// What a range read should return given the committed state and the reader's own writes.
pub fn merge_range(
    model: &Model,
    own: &Own,
    start: &[u8],
    end: &[u8],
    limit: usize,
) -> Vec<(Key, Value)> {
    let mut m: Model = model
        .range(start.to_vec()..end.to_vec())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (k, v) in own.range(start.to_vec()..end.to_vec()) {
        match v {
            Some(v) => {
                m.insert(k.clone(), v.clone());
            }
            None => {
                m.remove(k);
            }
        }
    }
    m.into_iter().take(limit).collect()
}

fn sorted(committed: &[Committed]) -> Vec<&Committed> {
    let mut order: Vec<&Committed> = committed.iter().collect();
    order.sort_by_key(|c| c.version);
    order
}

/// The state after replaying every commit with `version <= up_to`.
pub fn replay_to(committed: &[Committed], up_to: u64) -> Model {
    let mut model = Model::new();
    for c in sorted(committed) {
        if c.version <= up_to {
            apply_writes(&mut model, &c.writes);
        }
    }
    model
}

/// Serializability of the committed history. Two properties:
/// 1. Replaying the transactions one at a time in commit order reproduces every read each one
///    saw (so the result is equivalent to a serial execution).
/// 2. No committed transaction read something another committed transaction overwrote between
///    its snapshot and its commit.
///
/// Returns the final state of the replay.
pub fn check_serializable(committed: &[Committed]) -> Result<Model, Violation> {
    let ns = |m: String| violation(Class::Nonserializable, m);
    let order = sorted(committed);
    for w in order.windows(2) {
        if w[0].version >= w[1].version {
            return Err(ns(format!(
                "duplicate or unordered commit version {}",
                w[1].version
            )));
        }
    }
    let mut model = Model::new();
    for c in &order {
        for r in &c.reads {
            match r {
                ReadObs::Point { key, value } => {
                    if model.get(key) != value.as_ref() {
                        return Err(ns(format!(
                            "txn at version {} read a stale value of {:?}",
                            c.version,
                            String::from_utf8_lossy(key)
                        )));
                    }
                }
                ReadObs::Range {
                    start,
                    end,
                    limit,
                    own,
                    rows,
                } => {
                    if &merge_range(&model, own, start, end, *limit) != rows {
                        return Err(ns(format!(
                            "txn at version {} saw a stale range",
                            c.version
                        )));
                    }
                }
            }
        }
        apply_writes(&mut model, &c.writes);
    }
    for c in &order {
        for other in order
            .iter()
            .filter(|o| o.version > c.snapshot && o.version < c.version)
        {
            for r in &c.reads {
                let clash = match r {
                    ReadObs::Point { key, .. } => other.writes.iter().any(|(w, _)| w == key),
                    ReadObs::Range {
                        start,
                        end,
                        rows,
                        limit,
                        ..
                    } => {
                        // The extent the read depended on: up to the last returned key if the
                        // page was full, else the whole requested range.
                        let hi = if rows.len() == *limit {
                            key_successor(&rows[rows.len() - 1].0)
                        } else {
                            end.clone()
                        };
                        other.writes.iter().any(|(w, _)| w >= start && *w < hi)
                    }
                };
                if clash {
                    return Err(ns(format!(
                        "txn at version {} committed although version {} overwrote data it read",
                        c.version, other.version
                    )));
                }
            }
        }
    }
    Ok(model)
}

/// No torn read: a snapshot taken when the store was at `version` must show exactly the state
/// replayed to that version, not a mixture of two commits.
pub fn check_snapshot(
    state: &Model,
    committed: &[Committed],
    version: u64,
) -> Result<(), Violation> {
    if &replay_to(committed, version) == state {
        Ok(())
    } else {
        Err(violation(
            Class::Torn,
            format!("a read at version {version} saw a state no commit prefix produces"),
        ))
    }
}

/// How reopening the store after a crash went.
#[derive(Clone, Debug)]
pub enum Reopen {
    /// The store opened at this commit version with this state.
    Opened { version: u64, state: Model },
    /// The store refused to open and said why. Acceptable only when the disk lied.
    Refused(String),
    /// Opening panicked. Never acceptable.
    Panicked(String),
}

#[derive(Clone, Debug, Default)]
pub struct Verdict {
    pub violations: Vec<Violation>,
    /// The store refused to reopen (a clean refusal, not a violation unless the disk was honest).
    pub refused: bool,
    /// Acknowledged commits are missing and the disk had lied about fsync, so that is expected.
    pub lost_after_lie: bool,
}

/// Recovery must either succeed with exactly a prefix of the history or refuse cleanly.
///
/// - `acked`: commits the store acknowledged before the crash.
/// - `in_doubt`: the commits of the one batch that was being committed when the crash hit (or
///   whose fsync failed). That batch is atomic: afterwards it is fully present or fully absent.
/// - `lied`: the disk reported a successful fsync that did nothing at some point.
///
/// Rules: the recovered version must be the last acknowledged version, or the last version of the
/// in-doubt batch; the recovered state must equal the replay up to it. Anything older loses an
/// acknowledged commit (expected only after a lie); anything else is torn or corrupt.
pub fn check_recovery(
    acked: &[Committed],
    in_doubt: &[Committed],
    lied: bool,
    reopen: &Reopen,
) -> Verdict {
    let mut v = Verdict::default();
    let acked_max = acked.iter().map(|c| c.version).max().unwrap_or(0);
    let doubt_max = in_doubt
        .iter()
        .map(|c| c.version)
        .max()
        .unwrap_or(acked_max);
    match reopen {
        Reopen::Panicked(m) => v
            .violations
            .push(violation(Class::Corrupt, format!("reopen panicked: {m}"))),
        Reopen::Refused(m) => {
            v.refused = true;
            if !lied {
                v.violations.push(violation(
                    Class::Corrupt,
                    format!("refused to reopen after a crash with honest fsync: {m}"),
                ));
            }
        }
        Reopen::Opened { version, state } => {
            let all: Vec<Committed> = acked.iter().chain(in_doubt).cloned().collect();
            let known = *version == 0 || all.iter().any(|c| c.version == *version);
            if !known || *version > doubt_max {
                v.violations.push(violation(
                    Class::Corrupt,
                    format!("recovered at version {version}, which no commit produced (acked up to {acked_max}, in doubt up to {doubt_max})"),
                ));
            } else if &replay_to(&all, *version) != state {
                v.violations.push(violation(
                    Class::Torn,
                    format!("recovered state at version {version} is not the replay of the commits up to it"),
                ));
            } else if *version < acked_max {
                if lied {
                    v.lost_after_lie = true;
                } else {
                    v.violations.push(violation(
                        Class::Lost,
                        format!("acknowledged commit(s) lost: recovered at {version}, acked up to {acked_max}"),
                    ));
                }
            } else if *version > acked_max && *version < doubt_max {
                v.violations.push(violation(
                    Class::Torn,
                    format!("the in-doubt batch is half applied: recovered at {version}, batch spans {acked_max}..{doubt_max}"),
                ));
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(k: &str, v: &str) -> (Key, Option<Value>) {
        (k.as_bytes().to_vec(), Some(v.as_bytes().to_vec()))
    }
    fn commit(snapshot: u64, version: u64, reads: Vec<ReadObs>, writes: WriteSet) -> Committed {
        Committed {
            snapshot,
            version,
            reads,
            writes,
        }
    }
    fn state(pairs: &[(&str, &str)]) -> Model {
        pairs
            .iter()
            .map(|(k, v)| (k.as_bytes().to_vec(), v.as_bytes().to_vec()))
            .collect()
    }
    fn history() -> Vec<Committed> {
        vec![
            commit(0, 1, vec![], vec![put("a", "1")]),
            commit(1, 2, vec![], vec![put("b", "2")]),
            commit(2, 3, vec![], vec![put("a", "3"), put("c", "3")]),
        ]
    }

    #[test]
    fn a_clean_history_is_serializable() {
        let m = check_serializable(&history()).unwrap();
        assert_eq!(m, state(&[("a", "3"), ("b", "2"), ("c", "3")]));
    }

    #[test]
    fn serializability_rejects_a_stale_read() {
        let mut h = history();
        h.push(commit(
            0,
            4,
            vec![ReadObs::Point {
                key: b"a".to_vec(),
                value: None,
            }],
            vec![],
        ));
        let e = check_serializable(&h).unwrap_err();
        assert_eq!(e.class, Class::Nonserializable);
        assert!(e.message.contains("stale"), "{}", e.message);
    }

    #[test]
    fn serializability_rejects_a_commit_over_an_overwritten_read() {
        // Reads b at snapshot 0 and sees the value version 2 wrote; version 2 > snapshot, so the
        // write-skew style check must reject it even though replay order would justify the read.
        let h = vec![
            commit(0, 1, vec![], vec![put("b", "2")]),
            commit(
                0,
                2,
                vec![ReadObs::Point {
                    key: b"b".to_vec(),
                    value: Some(b"2".to_vec()),
                }],
                vec![put("x", "1")],
            ),
        ];
        let e = check_serializable(&h).unwrap_err();
        assert!(e.message.contains("overwrote"), "{}", e.message);
    }

    #[test]
    fn serializability_rejects_a_stale_range_and_duplicate_versions() {
        let h = vec![
            commit(0, 1, vec![], vec![put("k/1", "x")]),
            commit(
                1,
                2,
                vec![ReadObs::Range {
                    start: b"k/".to_vec(),
                    end: b"k0".to_vec(),
                    limit: 5,
                    own: Own::new(),
                    rows: vec![],
                }],
                vec![],
            ),
        ];
        assert!(
            check_serializable(&h)
                .unwrap_err()
                .message
                .contains("stale range")
        );
        let dup = vec![commit(0, 1, vec![], vec![]), commit(0, 1, vec![], vec![])];
        assert_eq!(
            check_serializable(&dup).unwrap_err().class,
            Class::Nonserializable
        );
    }

    #[test]
    fn a_mixed_snapshot_is_a_torn_read() {
        let h = history();
        assert!(check_snapshot(&replay_to(&h, 3), &h, 3).is_ok());
        // a=3 (from version 3) but c missing: half of commit 3
        let torn = state(&[("a", "3"), ("b", "2")]);
        assert_eq!(check_snapshot(&torn, &h, 3).unwrap_err().class, Class::Torn);
    }

    #[test]
    fn recovery_accepts_the_acked_prefix_or_the_whole_in_doubt_batch() {
        let h = history();
        let (acked, doubt) = (&h[..2], &h[2..]);
        for version in [2, 3] {
            let r = Reopen::Opened {
                version,
                state: replay_to(&h, version),
            };
            let v = check_recovery(acked, doubt, false, &r);
            assert!(
                v.violations.is_empty(),
                "version {version}: {:?}",
                v.violations
            );
        }
    }

    #[test]
    fn recovery_flags_lost_torn_phantom_and_corrupt_outcomes() {
        let h = history();
        let (acked, doubt) = (&h[..2], &h[2..]);
        let class = |r: Reopen, lied| {
            check_recovery(acked, doubt, lied, &r)
                .violations
                .first()
                .map(|v| v.class)
        };

        // lost: recovered at version 1 although version 2 was acknowledged
        let lost = Reopen::Opened {
            version: 1,
            state: replay_to(&h, 1),
        };
        assert_eq!(class(lost.clone(), false), Some(Class::Lost));
        // ...but expected after a lie
        let v = check_recovery(acked, doubt, true, &lost);
        assert!(v.violations.is_empty() && v.lost_after_lie);

        // torn: claims version 3 but only half of its writes are there
        let torn = Reopen::Opened {
            version: 3,
            state: state(&[("a", "3"), ("b", "2")]),
        };
        assert_eq!(class(torn.clone(), false), Some(Class::Torn));
        assert_eq!(
            class(torn, true),
            Some(Class::Torn),
            "a lie does not excuse a torn state"
        );

        // phantom version nobody committed
        let phantom = Reopen::Opened {
            version: 9,
            state: replay_to(&h, 3),
        };
        assert_eq!(class(phantom, false), Some(Class::Corrupt));

        // panics are never fine; refusal is fine only after a lie
        assert_eq!(
            class(Reopen::Panicked("x".into()), true),
            Some(Class::Corrupt)
        );
        assert_eq!(
            class(Reopen::Refused("bad checksum".into()), false),
            Some(Class::Corrupt)
        );
        let v = check_recovery(acked, doubt, true, &Reopen::Refused("bad checksum".into()));
        assert!(v.violations.is_empty() && v.refused);
    }

    #[test]
    fn a_batch_split_in_the_middle_is_torn() {
        // The in-doubt batch has two commits (versions 3 and 4); recovering at 3 is half a batch.
        let mut h = history();
        h.push(commit(2, 4, vec![], vec![put("d", "4")]));
        let (acked, doubt) = (&h[..2], &h[2..]);
        let r = Reopen::Opened {
            version: 3,
            state: replay_to(&h, 3),
        };
        assert_eq!(
            check_recovery(acked, doubt, false, &r).violations[0].class,
            Class::Torn
        );
    }
}
