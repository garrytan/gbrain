/**
 * Real-Postgres convergence regression for full-sync delete reconciliation.
 * The actual operation handler must return a structured block, retain the
 * prior bookmark, and converge on an explicit retry.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { withEnv } from '../helpers/with-env.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('full-sync reconcile convergence on Postgres', () => {
  let repoPath: string;
  let brainHome: string;

  beforeAll(async () => {
    await setupDB();
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-full-reconcile-pg-'));
    brainHome = mkdtempSync(join(tmpdir(), 'gbrain-full-reconcile-pg-home-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    for (let i = 0; i < 21; i++) {
      writeFileSync(join(repoPath, `topics/page-${String(i).padStart(2, '0')}.md`), [
        '---', 'type: concept', `title: Page ${i}`, '---', '', `page ${i}`,
      ].join('\n'));
    }
    execSync('git add -A && git commit -m "initial fixture"', { cwd: repoPath, stdio: 'pipe' });
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    if (brainHome) rmSync(brainHome, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return {
      engine: getEngine(),
      config: {} as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {}, debug() {} } as OperationContext['logger'],
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
  }

  async function syncFull(): Promise<SyncResult> {
    return withEnv({ GBRAIN_HOME: brainHome }, () =>
      operationsByName.sync_brain.handler(ctx(), {
        repo: repoPath,
        full: true,
        no_pull: true,
        no_embed: true,
      }) as Promise<SyncResult>,
    );
  }

  async function bookmark(): Promise<string | null> {
    const rows = await getEngine().executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    return rows[0]?.last_commit ?? null;
  }

  async function activePages(): Promise<number> {
    const rows = await getEngine().executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NULL`,
    );
    return rows[0]?.n ?? 0;
  }

  test('mass refusal does not advance; explicit retry converges and advances', async () => {
    expect((await syncFull()).status).toBe('first_sync');
    const originalBookmark = await bookmark();
    expect(await activePages()).toBe(21);

    for (let i = 0; i < 11; i++) {
      rmSync(join(repoPath, `topics/page-${String(i).padStart(2, '0')}.md`));
    }
    execSync('git add -A && git commit -m "bulk removal"', { cwd: repoPath, stdio: 'pipe' });
    const deletionHead = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();

    const blocked = await withEnv(
      { GBRAIN_ALLOW_MASS_RECONCILE: undefined },
      () => syncFull(),
    );
    expect(blocked.status).toBe('blocked_by_reconcile');
    expect(blocked.reconcile).toMatchObject({
      reason: 'mass_delete_refused',
      plannedDeletes: 11,
      completedDeletes: 0,
      failedDeletes: 11,
    });
    expect(await bookmark()).toBe(originalBookmark);
    expect(await activePages()).toBe(21);

    const retried = await withEnv(
      { GBRAIN_ALLOW_MASS_RECONCILE: '1' },
      () => syncFull(),
    );
    expect(retried.status).toBe('first_sync');
    expect(retried.deleted).toBe(11);
    expect(await bookmark()).toBe(deletionHead);
    expect(await activePages()).toBe(10);
  }, 180_000);
});
