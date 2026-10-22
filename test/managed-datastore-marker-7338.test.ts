/**
 * #7338: a managed PGLite brain whose database directory sits inside an unrelated Git checkout registered that directory
 * as a managed root and wrote its Git marker into the enclosing repository's metadata. That marked the whole checkout
 * managed, so every later write anywhere in it (another brain's sync, an ordinary file write) was refused
 * `writer_coordinator_required`. The nightly freshness gate's classic cell, built inside the gbrain checkout after the
 * managed PGLite cell, never synced. The datastore stays registered (a write inside it is still refused), but its
 * enclosing repository is not marked.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isManagedFilesystemPath, refreshManagedFilesystemRoots } from '../src/core/persistence/filesystem-guard.ts';
import { managedBrain } from './helpers/managed-brain.ts';

test('#7338: a managed datastore inside an unrelated checkout does not mark that checkout managed', () => managedBrain(async ({ engine }) => {
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-unrelated-checkout-'));
  try {
    execFileSync('git', ['-C', repo, 'init', '-q']);
    const datastore = join(repo, '.context', 'brain.pglite');
    mkdirSync(datastore, { recursive: true });
    await refreshManagedFilesystemRoots(engine, datastore);
    expect(isManagedFilesystemPath(join(datastore, 'base'))).toBe(true);
    expect(existsSync(join(repo, '.git', 'gbrain-managed.json'))).toBe(false);
    expect(isManagedFilesystemPath(join(repo, 'other-brain', 'notes', 'a.md'))).toBe(false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
}));
