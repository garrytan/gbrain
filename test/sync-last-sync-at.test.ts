/**
 * Regression guard: successful no-op source syncs should refresh last_sync_at.
 *
 * Doctor/source-health uses sources.last_sync_at as freshness, so an unchanged
 * git HEAD that syncs successfully must still mark the source checked. Before
 * this test, performSync returned `up_to_date` before touching last_sync_at,
 * making healthy autopilot polling look stale forever.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-last-sync-at-'));
  git(['init']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'GBrain Test']);
  writeFileSync(join(repoPath, 'note.md'), '# Freshness probe\n\nHello.\n');
  git(['add', 'note.md']);
  git(['commit', '-m', 'initial']);
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

describe('source sync freshness', () => {
  test('up_to_date source sync refreshes sources.last_sync_at', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('notes', 'notes', $1, '{"federated":true}'::jsonb)`,
      [repoPath],
    );

    const first = await performSync(engine, {
      sourceId: 'notes',
      repoPath,
      noPull: true,
      noEmbed: true,
    });
    expect(first.status).toBe('first_sync');

    await engine.executeRaw(
      `UPDATE sources SET last_sync_at = now() - interval '1 day' WHERE id = 'notes'`,
    );
    const before = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = 'notes'`,
    );

    const second = await performSync(engine, {
      sourceId: 'notes',
      repoPath,
      noPull: true,
      noEmbed: true,
    });
    expect(second.status).toBe('up_to_date');

    const after = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = 'notes'`,
    );
    expect(new Date(after[0].last_sync_at).getTime()).toBeGreaterThan(
      new Date(before[0].last_sync_at).getTime(),
    );
  });
});
