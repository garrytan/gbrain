/**
 * The Rust census report (scripts/rust-census/normalize.ts) on where an arm's answer differs.
 *
 * 1. Contract: for a row that is not equal, the census JSON names the first place each arm (Rust, Postgres) differs
 *    from the PGLite reference, as a JSON path with both values, and keeps a short masked excerpt of the Postgres
 *    output like the Rust one; an equal pair has no diff.
 * 2. Regression that fails it: the report keeping only a "differs" status for Postgres (no excerpt, no path), so a
 *    Postgres-vs-PGLite difference cannot be explained without a rerun; or a diff walker that stops at the first
 *    key it sees, names a key both sides share, or misses a key one side lacks.
 * 3. Existing coverage: none; test/rust-census-normalize.test.ts pins the masking, not the comparison report.
 * 4. Production seam: none; both helpers are pure census modules over already-normalised values.
 */
import { describe, expect, test } from 'bun:test';
import { firstDiff, maskedExcerpt, normalize } from '../scripts/rust-census/normalize.ts';

describe('census first diff', () => {
  test('equal answers have no diff, whatever the key order', () => {
    expect(firstDiff({ exit: 0, out: { a: 1, b: [1, 2] } }, { exit: 0, out: { b: [1, 2], a: 1 } })).toBeNull();
  });

  test('an exit code difference is named before any output difference', () => {
    expect(firstDiff({ exit: 0, out: { a: 1 } }, { exit: 1, out: { a: 2 } })).toEqual({ path: '$.exit', ref: '0', arm: '1' });
  });

  test('the first differing leaf, in sorted-key and array-index order', () => {
    const ref = { exit: 0, out: { facts: [{ id: 1, text: 'tea' }, { id: 2, text: 'coffee' }], zeta: 'x' } };
    const arm = { exit: 0, out: { facts: [{ id: 1, text: 'tea' }, { id: 2, text: 'cocoa' }], zeta: 'y' } };
    expect(firstDiff(ref, arm)).toEqual({ path: '$.out.facts[1].text@2', ref: '"coffee"', arm: '"cocoa"' });
  });

  test('a key or an element one side lacks is named, with <missing> for the absent side', () => {
    expect(firstDiff({ exit: 0, out: { a: 1 } }, { exit: 0, out: { a: 1, b: null } })).toEqual({ path: '$.out.b', ref: '<missing>', arm: 'null' });
    expect(firstDiff({ exit: 0, out: [1, 2, 3] }, { exit: 0, out: [1, 2] })).toEqual({ path: '$.out[2]', ref: '3', arm: '<missing>' });
  });

  test('a type change at a node is named at that node, values cut to 120 characters', () => {
    const long = 'x'.repeat(300);
    const d = firstDiff({ exit: 0, out: { body: { text: long } } }, { exit: 0, out: { body: long } });
    expect(d?.path).toBe('$.out.body');
    expect(d?.ref).toBe(JSON.stringify({ text: long }).slice(0, 120));
    expect(d?.arm).toBe(JSON.stringify(long).slice(0, 120));
  });

  test('two long strings are named at the first differing character, with the text around it', () => {
    const head = 'h'.repeat(500);
    const d = firstDiff({ exit: 0, out: { body: `${head}fix: gbrain init --path <db>` } }, { exit: 0, out: { body: `${head}fix: gbrain init\nnext` } });
    expect(d).toEqual({ path: '$.out.body@516', ref: JSON.stringify(`${'h'.repeat(4)}fix: gbrain init --path <db>`), arm: JSON.stringify(`${'h'.repeat(4)}fix: gbrain init\nnext`) });
    expect(firstDiff({ exit: 0, out: 'abc' }, { exit: 0, out: 'abcd' })).toEqual({ path: '$.out@3', ref: '"abc"', arm: '"abcd"' });
  });

  test('clocks normalise away before the diff, so only a real difference is named', () => {
    const a = normalize({ created_at: '2026-11-19T06:00:00Z', fact: 'tea' }, []);
    const b = normalize({ created_at: '2026-11-19T07:30:00Z', fact: 'tea' }, []);
    expect(firstDiff({ exit: 0, out: a }, { exit: 0, out: b })).toBeNull();
  });
});

describe('census masked excerpt', () => {
  test('masks the temp paths and cuts to the limit', () => {
    const text = '  {"dir":"/var/tmp/w/cases/cli-3/pg","db":"census_pg_3"}  ';
    expect(maskedExcerpt(text, [['census_pg_3', '<db>'], ['/var/tmp/w/cases/cli-3/pg', '<case>']])).toBe('{"dir":"<case>","db":"<db>"}');
    expect(maskedExcerpt('y'.repeat(900), []).length).toBe(600);
    expect(maskedExcerpt('abcdef', [], 3)).toBe('abc');
  });
});
