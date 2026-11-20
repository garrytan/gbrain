//! The reads link preparation made through `executeRaw` (`src/core/engine-sql/links-preparation.ts`):
//! the alias slugs a link may follow, and one source's slug fingerprint.
//!
//! Members: readLiveSlugAliases, probeSourceSlugFingerprint, readSourceSlugFingerprint.
//!
//! The fingerprint is the SQL's `count(*)`, `sum(hashtextextended(slug, 0))` and `max(id)` over the
//! source's page rows, a soft-deleted page included, so a caller that keeps an index of the slugs
//! can tell when it changed. [`hashtextextended`] is PostgreSQL's function for seed 0, so the sum is
//! the one a Postgres or PGLite brain returns for the same slugs.

use crate::Store;
use crate::aliases::read_slug_alias;
use crate::error::Result;
use crate::keys;
use crate::kv::scan_prefix;
use crate::pages::{PageRecord, read_page};
use serde_json::{Value, json};

/// The 32-bit mix of PostgreSQL's `hash_any_extended` (lookup3).
fn mix(a: &mut u32, b: &mut u32, c: &mut u32) {
    *a = a.wrapping_sub(*c);
    *a ^= c.rotate_left(4);
    *c = c.wrapping_add(*b);
    *b = b.wrapping_sub(*a);
    *b ^= a.rotate_left(6);
    *a = a.wrapping_add(*c);
    *c = c.wrapping_sub(*b);
    *c ^= b.rotate_left(8);
    *b = b.wrapping_add(*a);
    *a = a.wrapping_sub(*c);
    *a ^= c.rotate_left(16);
    *c = c.wrapping_add(*b);
    *b = b.wrapping_sub(*a);
    *b ^= a.rotate_left(19);
    *a = a.wrapping_add(*c);
    *c = c.wrapping_sub(*b);
    *c ^= b.rotate_left(4);
    *b = b.wrapping_add(*a);
}

/// The final scramble of `hash_any_extended`.
fn finish(a: &mut u32, b: &mut u32, c: &mut u32) {
    *c ^= *b;
    *c = c.wrapping_sub(b.rotate_left(14));
    *a ^= *c;
    *a = a.wrapping_sub(c.rotate_left(11));
    *b ^= *a;
    *b = b.wrapping_sub(a.rotate_left(25));
    *c ^= *b;
    *c = c.wrapping_sub(b.rotate_left(16));
    *a ^= *c;
    *a = a.wrapping_sub(c.rotate_left(4));
    *b ^= *a;
    *b = b.wrapping_sub(a.rotate_left(14));
    *c ^= *b;
    *c = c.wrapping_sub(b.rotate_left(24));
}

fn word(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// PostgreSQL `hashtextextended(text, 0)`: `hash_any_extended` over the text's UTF-8 bytes with
/// seed 0 (so no seed words are mixed in), as a signed 64-bit integer.
pub fn hashtextextended(text: &str) -> i64 {
    let bytes = text.as_bytes();
    let init = 0x9e37_79b9u32
        .wrapping_add(bytes.len() as u32)
        .wrapping_add(3_923_095);
    let (mut a, mut b, mut c) = (init, init, init);
    let mut rest = bytes;
    while rest.len() >= 12 {
        a = a.wrapping_add(word(&rest[0..4]));
        b = b.wrapping_add(word(&rest[4..8]));
        c = c.wrapping_add(word(&rest[8..12]));
        mix(&mut a, &mut b, &mut c);
        rest = &rest[12..];
    }
    // The last 0..11 bytes: bytes 0..3 go to `a`, 4..7 to `b`, and 8..10 to the upper three bytes
    // of `c` (its low byte is the length's).
    for (i, &byte) in rest.iter().enumerate() {
        let byte = u32::from(byte);
        match i {
            0..=3 => a = a.wrapping_add(byte << (8 * i)),
            4..=7 => b = b.wrapping_add(byte << (8 * (i - 4))),
            _ => c = c.wrapping_add(byte << (8 * (i - 8) + 8)),
        }
    }
    finish(&mut a, &mut b, &mut c);
    ((u64::from(b) << 32) | u64::from(c)) as i64
}

/// A source's page rows as `(id, slug)`, in slug byte order. A source that cannot be a
/// key part (it holds a NUL byte) has none.
fn source_slugs(store: &Store, source: &str) -> Result<Vec<(u64, String)>> {
    if source.contains('\0') {
        return Ok(Vec::new());
    }
    let read = store.read()?;
    let mut prefix = vec![keys::PAGE];
    prefix.extend_from_slice(source.as_bytes());
    prefix.push(0);
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(&*read, &prefix, false, &mut |_, v| {
        match serde_json::from_slice::<PageRecord>(v) {
            Ok(page) if page.source_id == source => out.push((page.id, page.slug)),
            Ok(_) => {}
            Err(e) => failure = Some(e.into()),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The fingerprint of the given rows: `n`, `h` (the hash sum, as `sum(int8)` prints it) and `m`.
fn fingerprint(rows: &[(u64, String)]) -> (usize, i128, u64) {
    let sum = rows
        .iter()
        .map(|(_, slug)| i128::from(hashtextextended(slug)))
        .sum();
    (
        rows.len(),
        sum,
        rows.iter().map(|(id, _)| *id).max().unwrap_or(0),
    )
}

impl Store {
    /// `readLiveSlugAliases(sourceId, targets)`: for each distinct target that is the `alias_slug`
    /// of a `slug_aliases` row in the source, `{ alias_slug, canonical_slug }` when no page of the
    /// source that is not soft-deleted sits at the alias slug and one does at the canonical slug.
    /// Live here means not soft-deleted: a quarantined page counts, as the SQL's test does. The
    /// rows follow the targets' byte order.
    pub fn read_live_slug_aliases(
        &self,
        source_id: &str,
        targets: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut distinct: Vec<&String> = targets.iter().collect();
        distinct.sort();
        distinct.dedup();
        let mut out = Vec::new();
        for alias in distinct {
            let Some(row) = read_slug_alias(&*read, source_id, alias)? else {
                continue;
            };
            let live = |slug: &str| -> Result<bool> {
                Ok(read_page(&*read, source_id, slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
            };
            if !live(alias)? && live(&row.canonical_slug)? {
                out.push(json!({"alias_slug": alias, "canonical_slug": row.canonical_slug}));
            }
        }
        Ok(out)
    }

    /// `probeSourceSlugFingerprint(sourceId, afterId)`: `{ n, h, m, added, added_h }`, the source's
    /// fingerprint with the slugs of the pages whose id is above `after_id` and their hash sum.
    pub fn probe_source_slug_fingerprint(&self, source_id: &str, after_id: i64) -> Result<Value> {
        let rows = source_slugs(self, source_id)?;
        let (n, h, m) = fingerprint(&rows);
        let added: Vec<(u64, String)> = rows
            .into_iter()
            .filter(|(id, _)| i128::from(*id) > i128::from(after_id))
            .collect();
        let (_, added_h, _) = fingerprint(&added);
        let added: Vec<String> = added.into_iter().map(|(_, slug)| slug).collect();
        Ok(
            json!({"n": n, "h": h.to_string(), "m": m, "added": added, "added_h": added_h.to_string()}),
        )
    }

    /// `readSourceSlugFingerprint(sourceId)`: `{ n, h, m, slugs }`, the fingerprint with every slug.
    pub fn read_source_slug_fingerprint(&self, source_id: &str) -> Result<Value> {
        let rows = source_slugs(self, source_id)?;
        let (n, h, m) = fingerprint(&rows);
        let slugs: Vec<String> = rows.into_iter().map(|(_, slug)| slug).collect();
        Ok(json!({"n": n, "h": h.to_string(), "m": m, "slugs": slugs}))
    }
}

#[cfg(test)]
mod tests {
    use super::hashtextextended;

    /// Values `SELECT hashtextextended(s, 0)` returned on PostgreSQL 16 (UTF8 database), at every
    /// tail length from 0 to 11 bytes, the 12-byte block edge, two and more blocks, and multibyte text.
    const PG: &[(&str, i64)] = &[
        ("", -6939563903564495251),
        ("a", 3591986179850072241),
        ("ab", 2833316173711343549),
        ("abc", -6747756470228489321),
        ("abcd", -1038429303365892052),
        ("abcde", 3076356108696143428),
        ("abcdefg", -6158032784613548338),
        ("abcdefgh", -8882191227074733005),
        ("abcdefghi", -3278210106038014113),
        ("abcdefghij", -3183301415634409076),
        ("abcdefghijk", 3112909444737856467),
        ("abcdefghijkl", -7556637188122330412),
        ("abcdefghijklm", 8871624171452417744),
        ("people/alice-example", -1644450466489052593),
        ("people/bob-old", -2011568021321695287),
        ("notes/batch-a", -2262429381893443426),
        ("abcdefghijklmnopqrstuvwx", -1933194731779935345),
        ("abcdefghijklmnopqrstuvwxy", 5649064133428767341),
        ("notes/caf\u{e9}", 277018652706547000),
        ("people/\u{65e5}\u{672c}\u{8a9e}", 1077131567656981367),
        ("x\u{1f600}y", 7397499706055283166),
        ("people/alice-example-0123456789", -2339902960811361253),
        (
            "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z",
            -4589198243371408950,
        ),
    ];

    #[test]
    fn hashtextextended_matches_postgres() {
        for (text, expected) in PG {
            assert_eq!(
                hashtextextended(text),
                *expected,
                "hashtextextended({text:?}, 0)"
            );
        }
    }
}
