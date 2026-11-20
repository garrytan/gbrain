/**
 * Text keys for byte-order cases: each list sorts one way by byte (PGLite, the Rust store, and Postgres with
 * `COLLATE "C"`) and another way under an en_US Postgres collation, which skips punctuation and folds case.
 *
 * A case seeds one of these lists in the MIXED order and expects the BYTE order back. On an en_US Postgres it fails
 * while the statement still sorts without `COLLATE "C"`. CI's Postgres runs in C.UTF-8, where both orders agree, so
 * prove a new case fails first against an en_US database (LC_COLLATE en_US.utf8).
 */

/** Ids with punctuation and an upper-case letter. en_US sorts them `a.b, a_b, ab, a-z, B`; bytes put `B` first. */
export const MIXED_IDS = ['ab', 'a_b', 'B', 'a-z', 'a.b'] as const;
/** MIXED_IDS in byte order. */
export const BYTE_IDS = ['B', 'a-z', 'a.b', 'a_b', 'ab'] as const;

/** Slug-safe keys (lower case, `-` and `/` only). en_US sorts them `ab, a-z, a/z`; bytes put `ab` last. */
export const MIXED_SLUGS = ['ab', 'a/z', 'a-z'] as const;
/** MIXED_SLUGS in byte order. */
export const BYTE_SLUGS = ['a-z', 'a/z', 'ab'] as const;

/** A copy of `values` sorted by their UTF-8 bytes, the order `COLLATE "C"` gives. */
export function byteOrder<T extends string>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}
