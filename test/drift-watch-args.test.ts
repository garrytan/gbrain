/** Wave 13: `filesDriftedSince` runs git through execFileSync; a commit argument can never become a git option. */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { filesDriftedSince } from '../src/core/eval/drift-watch.ts';

test('an option-shaped or empty commit argument returns null and runs nothing', () => {
  const probe = join(import.meta.dir, '..', '.context', 'drift-watch-option-probe');
  expect(filesDriftedSince(join(import.meta.dir, '..'), `--output=${probe}`)).toBeNull();
  expect(existsSync(probe)).toBe(false);
  expect(filesDriftedSince(join(import.meta.dir, '..'), '')).toBeNull();
});
