/**
 * #5699: the explicit atom retry compares the input the drain keys on plus
 * the extracted text's hash. A revision-only or visibility-only page change
 * is the same input; a transcript whose text changed under its retained
 * content hash is not, so retained atoms never publish against new text.
 */
import { expect, test } from 'bun:test';
import { atomRetryInputKey, type AtomOrigin, type ManagedAtomSession } from '../src/core/persistence/atom-maintenance.ts';

const session = { sourceId: 'default', incarnation: '00000000-0000-4000-8000-000000000001' } as ManagedAtomSession;
const page: AtomOrigin = { kind: 'page', locator: 'notes/example', contentHash: 'a'.repeat(64), textHash: 'b'.repeat(64),
  pageId: 7, revision: 'rev-1', visibility: 'private' } as AtomOrigin;

test('a revision-only or visibility-only change keeps the retry input', () => {
  expect(atomRetryInputKey(session, { ...page, revision: 'rev-2', visibility: 'world' } as AtomOrigin)).toBe(atomRetryInputKey(session, page));
});

test('changed content, text or identity changes the retry input', () => {
  const key = atomRetryInputKey(session, page);
  for (const changed of [{ contentHash: 'c'.repeat(64) }, { textHash: 'd'.repeat(64) }, { pageId: 8 }, { locator: 'notes/other' }]) {
    expect(atomRetryInputKey(session, { ...page, ...changed } as AtomOrigin)).not.toBe(key);
  }
  expect(atomRetryInputKey({ ...session, incarnation: '00000000-0000-4000-8000-000000000002' }, page)).not.toBe(key);
});

test('a transcript edited under its retained content hash is a different input', () => {
  const transcript = { ...page, kind: 'transcript', locator: '/synthetic/meeting.txt', pageId: null, revision: null } as AtomOrigin;
  expect(atomRetryInputKey(session, { ...transcript, textHash: 'e'.repeat(64) } as AtomOrigin)).not.toBe(atomRetryInputKey(session, transcript));
});
