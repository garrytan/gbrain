/**
 * The byte contract the follower and reconcile share with the Rust store (rust/docs/store/seed.md, "Follow and
 * reconcile"). Rust treats every value here as opaque bytes, so the primary's key order and row content are defined
 * once, in this file:
 *
 * - **Sort key.** A primary-key tuple as bytes whose byte order equals the order `readKeysetRows` reads the table in
 *   (COLLATE "C" for text, native for the rest). Per column, concatenated: a 2/4/8-byte integer as 8 bytes big-endian
 *   with the sign bit flipped; a uuid as its 16 bytes; a collatable (text) value as its UTF-8 bytes then `00 00`
 *   (Postgres text holds no NUL byte, so the terminator sorts before every continuation). Any other key type has no
 *   sort key: the relation cannot be reconciled and the follower marks it relation-level dirty.
 * - **Row digest.** sha256 over the row's columns sorted by name (byte order): per column `u32be(len name) name`,
 *   then `00` for SQL NULL or `01 u32be(len value) value` for its `::text`.
 * - **Interval digest.** sha256 over the rows of an interval in sort-key order: per row `u32be(len sort) sort digest`.
 *   An empty interval digests to sha256 of nothing.
 */
import { createHash } from 'node:crypto';
import type { ColumnMeta } from '../core/persistence/engine-graduation.types.ts';

const INT_TYPES = new Set(['smallint', 'integer', 'bigint']);

/** Why a key column has no sort key, or null when every key column has one. */
export function sortKeyUnsupported(key: readonly ColumnMeta[]): string | null {
  for (const c of key) {
    if (INT_TYPES.has(c.type) || c.type === 'uuid' || c.collatable) continue;
    return `key column ${c.name} has type ${c.type}, which has no sort key`;
  }
  return null;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function intBytes(text: string, column: string): Buffer {
  if (!/^-?\d+$/.test(text)) throw new Error(`Key column ${column} holds ${JSON.stringify(text)}, not an integer.`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt.asUintN(64, BigInt(text)) ^ (1n << 63n));
  return b;
}

function uuidBytes(text: string, column: string): Buffer {
  const hex = text.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Key column ${column} holds ${JSON.stringify(text)}, not a uuid.`);
  return Buffer.from(hex, 'hex');
}

/** The sort key of a key tuple (`values[i]` is the `::text` of `key[i]`). Throws on an unsupported key type. */
export function sortKey(key: readonly ColumnMeta[], values: readonly string[]): Buffer {
  if (values.length !== key.length) throw new Error(`Sort key needs ${key.length} values, got ${values.length}.`);
  const parts: Buffer[] = [];
  key.forEach((c, i) => {
    const v = values[i];
    if (INT_TYPES.has(c.type)) parts.push(intBytes(v, c.name));
    else if (c.type === 'uuid') parts.push(uuidBytes(v, c.name));
    else if (c.collatable) parts.push(Buffer.from(v, 'utf8'), Buffer.from([0, 0]));
    else throw new Error(`Key column ${c.name} has type ${c.type}, which has no sort key.`);
  });
  return Buffer.concat(parts);
}

/** The row digest of a row as `readKeysetRows` returns its values. */
export function rowDigest(values: Readonly<Record<string, string | null>>): Buffer {
  const h = createHash('sha256');
  const names = Object.keys(values).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of names) {
    const n = Buffer.from(name, 'utf8');
    h.update(u32(n.length)).update(n);
    const v = values[name];
    if (v === null || v === undefined) h.update(Buffer.from([0]));
    else {
      const b = Buffer.from(v, 'utf8');
      h.update(Buffer.from([1])).update(u32(b.length)).update(b);
    }
  }
  return h.digest();
}

/** The interval digest of rows already in sort-key order. */
export function intervalDigest(rows: Iterable<{ sort: Buffer; digest: Buffer }>): Buffer {
  const h = createHash('sha256');
  for (const r of rows) h.update(u32(r.sort.length)).update(r.sort).update(r.digest);
  return h.digest();
}
