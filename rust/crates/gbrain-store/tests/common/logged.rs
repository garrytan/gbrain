//! The rule "the commit log lives at the storage layer, so open-time upkeep, upgrades and rollbacks are logged too; no lane adds a
//! write path that skips it", as a check: replay the log records onto the image taken before a scenario and require byte equality
//! with the image taken after.
//!
//! A key that changed with no record fails; a record whose change is not in the store fails. Pure over `Image`, so a control can
//! show it fails.

use super::mu::{CommitRecord, Image};

fn describe(key: &[u8]) -> String {
    key.iter().map(|b| format!("{b:02x}")).collect()
}

/// Applies `records`, in order, to a copy of `before`: put, delete, add_i64 (the delta, 8 bytes little-endian, onto a counter
/// stored the same way, absent as 0) and raise_counter (the value, 8 bytes big-endian, kept at the larger).
pub fn replay(before: &Image, records: &[CommitRecord]) -> Result<Image, String> {
    let mut image = before.clone();
    for record in records {
        for op in &record.ops {
            match op.op {
                1 => {
                    image.insert(op.key.clone(), op.operand.clone());
                }
                2 => {
                    image.remove(&op.key);
                }
                3 => {
                    let delta: [u8; 8] = op.operand.as_slice().try_into().map_err(|_| {
                        format!(
                            "add_i64 of key {} has a {}-byte operand",
                            describe(&op.key),
                            op.operand.len()
                        )
                    })?;
                    let old = image
                        .get(&op.key)
                        .map(|b| <[u8; 8]>::try_from(b.as_slice()).map(i64::from_le_bytes))
                        .transpose()
                        .map_err(|_| {
                            format!("add_i64 onto a non-counter at key {}", describe(&op.key))
                        })?
                        .unwrap_or(0);
                    let new = old.wrapping_add(i64::from_le_bytes(delta));
                    image.insert(op.key.clone(), new.to_le_bytes().to_vec());
                }
                4 => {
                    let value: [u8; 8] = op.operand.as_slice().try_into().map_err(|_| {
                        format!(
                            "raise_counter of key {} has a {}-byte operand",
                            describe(&op.key),
                            op.operand.len()
                        )
                    })?;
                    let value = u64::from_be_bytes(value);
                    let old = image
                        .get(&op.key)
                        .and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok())
                        .map(u64::from_be_bytes)
                        .unwrap_or(0);
                    image.insert(op.key.clone(), old.max(value).to_be_bytes().to_vec());
                }
                other => return Err(format!("a record holds op {other}, which no replay knows")),
            }
        }
    }
    Ok(image)
}

/// `after` is exactly `before` plus what `records` say. The first mismatch is named: a key that changed with no record, or a
/// record whose change is not in the store.
pub fn log_explains_change(
    before: &Image,
    after: &Image,
    records: &[CommitRecord],
) -> Result<(), String> {
    let replayed = replay(before, records)?;
    let keys: std::collections::BTreeSet<&Vec<u8>> = before
        .keys()
        .chain(after.keys())
        .chain(replayed.keys())
        .collect();
    for key in keys {
        let (b, a, r) = (before.get(key), after.get(key), replayed.get(key));
        if a == r {
            continue;
        }
        return Err(if a == b {
            format!(
                "a record changes key {} but the store did not change it",
                describe(key)
            )
        } else {
            format!(
                "key {} changed with no record (or to a value its record does not hold)",
                describe(key)
            )
        });
    }
    Ok(())
}
