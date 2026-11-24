/** src/core/shared-skills/rust-publication.ts: only an engine whose kind is 'rust' is a Rust brain. */
import { expect, test } from 'bun:test';
import { isRustBrain } from '../src/core/shared-skills/rust-publication.ts';

test('isRustBrain is true only for the rust engine kind', () => {
  expect(isRustBrain({ kind: 'rust' })).toBe(true);
  for (const kind of ['pglite', 'postgres', 'RUST', undefined, null, 1]) expect(isRustBrain({ kind })).toBe(false);
  expect(isRustBrain({})).toBe(false);
});
