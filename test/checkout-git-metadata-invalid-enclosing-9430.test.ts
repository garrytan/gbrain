/** #9430: an enclosing `.git` directory that is not a valid repository is not the checkout of a root beneath it. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutGitMetadata } from '../src/core/persistence/root-registry.ts';

test('an empty enclosing .git directory is not treated as the root checkout', () => {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-invalid-git-9430-'));
  try {
    mkdirSync(join(base, '.git'));
    const clone = join(base, '.gbrain', 'clones', 'source-a-google');
    mkdirSync(clone, { recursive: true });
    let result: string | null | undefined, failure: unknown;
    try { result = checkoutGitMetadata(clone); } catch (error) { failure = error; }
    expect(failure).toBeUndefined();
    expect(result).toBeNull();
  } finally { rmSync(base, { recursive: true, force: true }); }
});
