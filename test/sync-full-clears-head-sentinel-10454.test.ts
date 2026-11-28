/**
 * #10454: a clean `gbrain sync --full` re-imports the whole tree at HEAD and re-anchors the source there, so an open
 * `<head>` (history rewrite) sentinel left by an earlier incremental run is resolved, the same as the incremental path
 * clears it once pin ancestry verifies (#2734). Before the fix the full path resolved only file rows, so doctor kept
 * reporting the sentinel after the reset an operator runs to clear it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { clearFailures, loadSyncFailures, recordFailures } from '../src/core/sync-failure-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });

let engine: PGLiteEngine;
let repo: string;
let ledger: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  ledger = mkdtempSync(join(tmpdir(), 'gbrain-10454-ledger-'));
  repo = mkdtempSync(join(tmpdir(), 'gbrain-10454-repo-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'note.md'), '---\ntype: note\ntitle: Note\n---\n\nBody.\n');
  git(repo, 'add', 'note.md');
  git(repo, 'commit', '-q', '-m', 'init');
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(repo, { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
}, 60_000);

describe('full sync and the <head> sentinel (#10454)', () => {
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a --full re-sync that blocks on a file it cannot read keeps the <head> row', async () => {
    const kept = await withEnv({ GBRAIN_SYNC_FAILURES_DIR: ledger }, async () => {
      recordFailures('default', [{ path: '<head>', error: 'git history rewritten during sync' }], 'old-commit');
      writeFileSync(join(repo, 'unreadable.md'), '---\ntype: note\ntitle: Unreadable\n---\n\nBody.\n');
      git(repo, 'add', 'unreadable.md');
      git(repo, 'commit', '-q', '-m', 'unreadable');
      chmodSync(join(repo, 'unreadable.md'), 0o000);
      try {
        await performSync(engine, { repoPath: repo, full: true, noPull: true, noEmbed: true }).catch(() => undefined);
        expect(loadSyncFailures().some(e => e.source_id === 'default' && e.path === 'unreadable.md' && e.state === 'open')).toBe(true);
        return loadSyncFailures().filter(e => e.source_id === 'default' && e.path === '<head>' && e.state === 'open');
      } finally {
        chmodSync(join(repo, 'unreadable.md'), 0o644);
        git(repo, 'rm', '-q', 'unreadable.md');
        git(repo, 'commit', '-q', '-m', 'remove unreadable');
        clearFailures('default', ['unreadable.md']);
      }
    });
    expect(kept.length).toBe(1);
  }, 60_000);

  test('a clean --full re-sync resolves an open <head> row', async () => {
    const open = await withEnv({ GBRAIN_SYNC_FAILURES_DIR: ledger }, async () => {
      recordFailures('default', [{ path: '<head>', error: 'git history rewritten during sync' }], 'old-commit');
      expect(loadSyncFailures().filter(e => e.source_id === 'default' && e.path === '<head>').length).toBe(1);
      await performSync(engine, { repoPath: repo, full: true, noPull: true, noEmbed: true });
      return loadSyncFailures().filter(e => e.source_id === 'default' && e.path === '<head>');
    });
    expect(open).toEqual([]);
  }, 60_000);
});
