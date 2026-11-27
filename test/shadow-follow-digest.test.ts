import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColumnMeta } from '../src/core/persistence/engine-graduation.types.ts';
import { intervalDigest, rowDigest, sortKey, sortKeyUnsupported } from '../src/shadow/follow-digest.ts';

const col = (name: string, type: string, collatable = false): ColumnMeta => ({ name, type, category: '', collatable, generated: false });
const int = col('id', 'bigint');
const txt = col('source_id', 'text', true);
const uid = col('u', 'uuid');

// The same vectors pin the Rust interval digest (rust/crates/gbrain-store/src/seed/follow tests).
const VECTORS = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'shadow-follow-digest-vectors.json'), 'utf8')) as Record<string, string>;

describe('follow digest byte contract', () => {
  test('sort keys match the pinned vectors', () => {
    expect(sortKey([int], ['5']).toString('hex')).toBe(VECTORS['sort int 5']);
    expect(sortKey([int], ['-1']).toString('hex')).toBe(VECTORS['sort int -1']);
    expect(sortKey([txt, int], ['default', '42']).toString('hex')).toBe(VECTORS['sort text,int default,42']);
    expect(sortKey([uid], ['0190a8b2-1c3d-7e4f-8a9b-0c1d2e3f4a5b']).toString('hex')).toBe(VECTORS['sort uuid']);
  });

  test('sort key byte order is the keyset read order', () => {
    const ints = ['-9223372036854775808', '-2', '-1', '0', '1', '9', '10', '9223372036854775807'];
    const keys = ints.map(v => sortKey([int], [v]));
    for (let i = 1; i < keys.length; i++) expect(Buffer.compare(keys[i - 1], keys[i])).toBe(-1);
    // COLLATE "C": byte order, a prefix first, upper case before lower case.
    const texts = ['A', 'B', 'a', 'ab', 'abc', 'b', 'é'];
    const tkeys = texts.map(v => sortKey([txt, int], [v, '1']));
    for (let i = 1; i < tkeys.length; i++) expect(Buffer.compare(tkeys[i - 1], tkeys[i])).toBe(-1);
    // A shorter first column sorts first even when the next column is larger.
    expect(Buffer.compare(sortKey([txt, int], ['a', '99']), sortKey([txt, int], ['ab', '1']))).toBe(-1);
  });

  test('row and interval digests match the pinned vectors', () => {
    const d1 = rowDigest({ slug: 'people/alice-example', id: '1', title: null, body: 'héllo' });
    expect(d1.toString('hex')).toBe(VECTORS['row {slug,id,title:null,body:héllo}']);
    expect(rowDigest({}).toString('hex')).toBe(VECTORS['row {}']);
    expect(intervalDigest([]).toString('hex')).toBe(VECTORS['interval empty']);
    expect(intervalDigest([{ sort: sortKey([int], ['1']), digest: d1 }, { sort: sortKey([int], ['5']), digest: rowDigest({}) }]).toString('hex'))
      .toBe(VECTORS['interval [int1:d1, int5:{}]']);
  });

  test('a row digest tells NULL from empty text and does not depend on column order', () => {
    expect(rowDigest({ a: null }).equals(rowDigest({ a: '' }))).toBe(false);
    expect(rowDigest({ a: '1', b: '2' }).equals(rowDigest({ b: '2', a: '1' }))).toBe(true);
    expect(rowDigest({ a: '12' }).equals(rowDigest({ a: '1', b: '2' }))).toBe(false);
  });

  test('a key type with no sort key is named, and a bad value is refused', () => {
    expect(sortKeyUnsupported([int, txt, uid])).toBeNull();
    expect(sortKeyUnsupported([col('at', 'timestamp with time zone')])).toContain('at');
    expect(() => sortKey([int], ['1.5'])).toThrow('not an integer');
    expect(() => sortKey([uid], ['nope'])).toThrow('not a uuid');
  });
});
