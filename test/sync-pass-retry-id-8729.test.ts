/**
 * #8729: an in-place re-freeze in a pass takes a request id derived from the failed request it replaces.
 *
 * 1. Protects: a retry never reuses a request id whose receipt already failed, even when the entry was frozen again
 *    in the same pass (a hold released) and its re-freeze count started over; the first freeze keeps the v1 id.
 * 2. Fails when: the retry id is salted with a count that restarts (two refreeze chains share retry ids) or the
 *    first-freeze id changes (a same-pass replay would stop reading its own receipt).
 */
import { expect, test } from 'bun:test';
import { passRequestId } from '../src/core/persistence/sync-pass-batch.ts';

const pass = '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b';
const failedA = '0b5e8f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const failedB = '1c6f9a4b-2d3e-4f60-9bac-1d2e3f4a5b6c';

test('the first freeze keeps the v1 id and each failed request names its own retry', () => {
  expect(passRequestId(pass, 'conversations/chat-example.md', null)).toBe('e08647ff-1a4d-56ef-b056-dfd637966c9c');
  const a = passRequestId(pass, 'conversations/chat-example.md', null, failedA);
  const b = passRequestId(pass, 'conversations/chat-example.md', null, failedB);
  expect(a).not.toBe(passRequestId(pass, 'conversations/chat-example.md', null));
  expect(a).not.toBe(b);
  expect(passRequestId(pass, 'conversations/chat-example.md', null, failedA.toUpperCase())).toBe(a);
});
