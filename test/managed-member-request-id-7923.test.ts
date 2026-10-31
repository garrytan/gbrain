import { expect, test } from 'bun:test';
import { memberRequestId } from '../src/core/generations/managed.ts';

test('managed member request IDs distinguish different item identities and replay identical ones', () => {
  const first = memberRequestId('activation', 'atoms/example', 'create', 'identity-a');
  expect(memberRequestId('activation', 'atoms/example', 'create', 'identity-a')).toBe(first);
  expect(memberRequestId('activation', 'atoms/example', 'create', 'identity-b')).not.toBe(first);
});
