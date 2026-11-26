import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadSyncFailures, recordFailures } from '../src/core/sync-failure-ledger.ts';

let engine: PGLiteEngine;
let repoPath: string;
let ledgerDir: string;

describe('full sync clears a stale <head> sentinel (#10454)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    ledgerDir = mkdtempSync(join(tmpdir(), 'gbrain-10454-ledger-'));
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-10454-repo-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@example.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'foo.md'), '---\ntype: concept\ntitle: Foo\n---\n\nBody.\n');
    execSync('git add -A && git commit -m init', { cwd: repoPath, stdio: 'pipe' });
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }, 60_000);

  test('clean --full re-sync removes the open <head> row', async () => {
    const open = await withEnv({ GBRAIN_SYNC_FAILURES_DIR: ledgerDir }, async () => {
      recordFailures('default', [{ path: '<head>', error: 'history rewrite' }], 'c1');
      const { performSync } = await import('../src/commands/sync.ts');
      await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
      return loadSyncFailures().filter(e => e.source_id === 'default' && e.path === '<head>');
    });
    expect(open.length).toBe(0);
  }, 60_000);
});
