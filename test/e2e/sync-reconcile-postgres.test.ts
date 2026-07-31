/**
 * #3583 — the rename reconcile against REAL PostgreSQL.
 *
 * The reconcile resolves its candidates through `engine.executeRaw` with a
 * slug-array binding (`= ANY($1::text[])`), which on this engine goes
 * through postgres.js `unsafe()`. Every other test for this feature runs on
 * PGLite, where that binding cannot fail the way it can on the real driver
 * — the review named exactly this as inferred rather than executed. These
 * tests exercise the reconcile end to end on Postgres: the stale row goes,
 * the live row sharing its `source_path` stays, and an orphaned
 * `<rename:…>` sentinel self-heals on a quiet run.
 *
 * Requires DATABASE_URL (skipped otherwise, like every e2e file here).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;
const repos: string[] = [];
let tmpHome: string | undefined;
const originalGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  if (skip) return;
  engine = (await setupDB()) as PostgresEngine;
});

afterAll(async () => {
  if (skip) return;
  if (originalGbrainHome !== undefined) process.env.GBRAIN_HOME = originalGbrainHome;
  else delete process.env.GBRAIN_HOME;
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  // The failure ledger lives under the gbrain home — isolate it per test so
  // a sentinel planted here never touches the operator's real ledger.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-3583-pg-home-'));
  process.env.GBRAIN_HOME = tmpHome;
  await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default'`);
  await engine.executeRaw(
    `UPDATE sources SET last_sync_at = NULL, last_commit = NULL WHERE id = 'default'`,
  );
});

function personMd(title: string, body: string): string {
  return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
}

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-3583-pg-'));
  repos.push(dir);
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

describeIfDB('#3583: rename reconcile on PostgreSQL', () => {
  test('occupied-destination rename: the stale row goes, the live row sharing its path stays', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    // The blocker-1 shape on the real driver: a cheap rename leaves the live
    // row carrying the OLD source_path, a new file reoccupies that path, and
    // a later rename of it into an occupied destination falls back to add +
    // reconcile. The reconcile's active-row resolve binds the path array
    // through executeRaw — the exact statement the review could not execute.
    const repo = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha the original.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "cheap rename"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/beta')).not.toBeNull();

    // A NEW unrelated file at the old path…
    writeFileSync(join(repo, 'people/alpha.md'), personMd('Alpha Two', 'A different Alpha.'));
    execSync('git add -A && git commit -m "new alpha"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // …renamed into an OCCUPIED destination (gamma pre-exists), forcing the
    // fallback-to-add + reconcile path.
    await engine.putPage('people/gamma', {
      type: 'person', title: 'Gamma (occupant)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/gamma.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename into occupied destination"', { cwd: repo, stdio: 'pipe' });
    const run = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(run.status).toBe('synced');

    // The destination carries the renamed file's content, the stale duplicate
    // is gone, and — the review's blocker-1 assertion — the LIVE beta row
    // (whose bookkeeping shared the old path) survives.
    const gamma = await engine.getPage('people/gamma');
    expect(gamma).not.toBeNull();
    expect(gamma!.compiled_truth).toContain('A different Alpha.');
    expect(await engine.getPage('people/alpha')).toBeNull();
    expect(await engine.getPage('people/beta')).not.toBeNull();
  }, 300_000);

  test('an orphaned rename sentinel self-heals on a quiet run', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const { recordFailures, renameSentinelPath, renameReconcileErrorMessage, loadSyncFailures } =
      await import('../../src/core/sync-failure-ledger.ts');
    // Blocker 2's sibling path on the real driver: the orphan probe resolves
    // "any active row still carrying this path?" through the same array
    // binding, and a clear must only happen when the answer is provably no.
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    recordFailures('default', [{
      path: renameSentinelPath('people/dana.md'),
      error: renameReconcileErrorMessage('people/dana-old.md', 'people/dana-old', 'injected wedge'),
    }], 'deadbeef');
    const open = () => loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    expect(open()).toHaveLength(1);

    const quiet = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(quiet.status).toBe('up_to_date');
    expect(open()).toHaveLength(0);
  }, 300_000);
});
