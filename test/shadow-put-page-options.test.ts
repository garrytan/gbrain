/**
 * The shadow write comparison judges a putPage by its options (src/shadow/write-capture.ts). The Rust store takes
 * `contextualRetrieval` (store-members/pages.ts), so the list of options it takes names it; but a write that stamps
 * contextual retrieval does so in a later write the replay does not carry, so that write is named uncomparable, and one that
 * turns it off (no option, or mode 'none') is compared as before.
 *
 * Protects: the options list names every option the store takes; an option set with a contextual-retrieval stamp is not
 * comparable; one without it, or with mode 'none', is; a key the store does not take still is not.
 * Fails when the list lacks a key the store takes, or a stamping write is judged comparable.
 * Pure: no engine.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUT_PAGE_OPTIONS, putPageOptionsComparable } from '../src/shadow/write-capture.ts';

test('the options list is the store\'s own, contextualRetrieval included', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'rust-engine', 'store-members', 'pages.ts'), 'utf8');
  const taken = /takeOptions\('putPage', opts, \[([^\]]*)\], \[([^\]]*)\]\)/.exec(source)!.slice(1).flatMap((list) => [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
  expect([...PUT_PAGE_OPTIONS].sort()).toEqual(taken.sort());
  expect(PUT_PAGE_OPTIONS.has('contextualRetrieval')).toBe(true);
});

test('a put_page that stamps contextual retrieval is not comparable; one that does not, is', () => {
  expect(putPageOptionsComparable(undefined)).toBe(true);
  expect(putPageOptionsComparable({ sourceId: 'default', inline: true })).toBe(true);
  expect(putPageOptionsComparable({ contextualRetrieval: { mode: 'none', corpusGeneration: null } })).toBe(true);
  expect(putPageOptionsComparable({ contextualRetrieval: undefined })).toBe(true);
  expect(putPageOptionsComparable({ contextualRetrieval: { mode: 'title', corpusGeneration: null } })).toBe(false);
  expect(putPageOptionsComparable({ sourceId: 'default', contextualRetrieval: { mode: 'llm', corpusGeneration: 3 } })).toBe(false);
});

test('a key the store does not take is still not comparable', () => {
  expect(putPageOptionsComparable({ reuseSegments: {} })).toBe(false);
  expect(putPageOptionsComparable({ sourceId: 'default', somethingNew: 1 })).toBe(false);
});
